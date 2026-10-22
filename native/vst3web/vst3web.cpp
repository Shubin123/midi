// vst3web: a minimal VST3 host compiled into the same WebAssembly module as a VST3 plug-in.
//
// Any VST3 plug-in whose source builds with the VST3 SDK can be linked with this file. The browser then
// talks to the plug-in through the plain C functions below, while this file drives the plug-in through
// the real VST3 interfaces (IPluginFactory, IComponent, IAudioProcessor, IEditController) exactly as a
// desktop host would. Uses the Steinberg VST3 SDK hosting helpers (MIT License).

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/processdata.h"

#include <string>
#include <vector>

using namespace Steinberg;
using namespace Steinberg::Vst;

extern "C" SMTG_EXPORT_SYMBOL IPluginFactory* PLUGIN_API GetPluginFactory ();
extern bool InitModule ();
extern bool DeinitModule ();

namespace {

std::string utf8 (const char16* s)
{
	std::string out;
	for (; s && *s; ++s)
	{
		uint32 c = static_cast<uint32> (*s);
		if (c >= 0xD800 && c <= 0xDBFF && s[1] >= 0xDC00 && s[1] <= 0xDFFF)
			c = 0x10000 + ((c - 0xD800) << 10) + (static_cast<uint32> (*++s) - 0xDC00);
		if (c < 0x80) out += static_cast<char> (c);
		else if (c < 0x800) { out += static_cast<char> (0xC0 | (c >> 6)); out += static_cast<char> (0x80 | (c & 0x3F)); }
		else if (c < 0x10000) { out += static_cast<char> (0xE0 | (c >> 12)); out += static_cast<char> (0x80 | ((c >> 6) & 0x3F)); out += static_cast<char> (0x80 | (c & 0x3F)); }
		else { out += static_cast<char> (0xF0 | (c >> 18)); out += static_cast<char> (0x80 | ((c >> 12) & 0x3F)); out += static_cast<char> (0x80 | ((c >> 6) & 0x3F)); out += static_cast<char> (0x80 | (c & 0x3F)); }
	}
	return out;
}

std::string json (const std::string& s)
{
	std::string out = "\"";
	for (unsigned char c : s)
	{
		if (c == '"' || c == '\\') { out += '\\'; out += static_cast<char> (c); }
		else if (c < 0x20) { char buf[8]; snprintf (buf, sizeof buf, "\\u%04x", c); out += buf; }
		else out += static_cast<char> (c);
	}
	return out + "\"";
}

struct Host
{
	HostApplication app;
	IPtr<IComponent> component;
	IPtr<IAudioProcessor> processor;
	IPtr<IEditController> controller;
	IPtr<IConnectionPoint> componentConnection, controllerConnection;
	HostProcessData data;
	ParameterChanges inputChanges {64};
	EventList events {512};
	ProcessContext context {};
	bool separateController = false;
	std::vector<ParamID> paramIds;
};

Host* host = nullptr;
std::vector<PClassInfo2> classes;
std::string text;

void listClasses ()
{
	if (!classes.empty ()) return;
	IPluginFactory* factory = GetPluginFactory ();
	FUnknownPtr<IPluginFactory2> factory2 (factory);
	for (int32 i = 0; factory && i < factory->countClasses (); ++i)
	{
		PClassInfo2 info {};
		if (factory2) factory2->getClassInfo2 (i, &info);
		else
		{
			PClassInfo basic {};
			factory->getClassInfo (i, &basic);
			memcpy (info.cid, basic.cid, sizeof (TUID));
			memcpy (info.category, basic.category, sizeof info.category);
			memcpy (info.name, basic.name, sizeof info.name);
		}
		if (strcmp (info.category, kVstAudioEffectClass) == 0) classes.push_back (info);
	}
}

BusInfo busInfo (MediaType type, BusDirection dir, int32 index)
{
	BusInfo info {};
	host->component->getBusInfo (type, dir, index, info);
	return info;
}

} // namespace

extern "C" {

SMTG_EXPORT_SYMBOL int vst3web_init ()
{
	static bool done = InitModule ();
	return done ? 0 : -1;
}

SMTG_EXPORT_SYMBOL int vst3web_class_count () { listClasses (); return static_cast<int> (classes.size ()); }

// JSON: { name, vendor, version, sdkVersion, subCategories, cid }
SMTG_EXPORT_SYMBOL const char* vst3web_class_info (int index)
{
	listClasses ();
	if (index < 0 || index >= static_cast<int> (classes.size ())) return "null";
	const PClassInfo2& c = classes[index];
	char cid[33];
	for (int i = 0; i < 16; ++i) snprintf (cid + i * 2, 3, "%02X", static_cast<unsigned char> (c.cid[i]));
	text = "{\"name\":" + json (c.name) + ",\"vendor\":" + json (c.vendor) + ",\"version\":" + json (c.version) +
	       ",\"sdkVersion\":" + json (c.sdkVersion) + ",\"subCategories\":" + json (c.subCategories) + ",\"cid\":\"" + cid + "\"}";
	return text.c_str ();
}

SMTG_EXPORT_SYMBOL void vst3web_close ();

// Creates class `index`, connects its controller, and starts processing. Returns 0 on success.
SMTG_EXPORT_SYMBOL int vst3web_open (int index, double sampleRate, int maxBlock)
{
	vst3web_close ();
	listClasses ();
	if (index < 0 || index >= static_cast<int> (classes.size ())) return -1;
	IPluginFactory* factory = GetPluginFactory ();
	host = new Host;
	if (factory->createInstance (classes[index].cid, IComponent::iid, reinterpret_cast<void**> (&host->component)) != kResultOk || !host->component)
		return -2;
	if (host->component->initialize (&host->app) != kResultOk) return -3;
	host->processor = U::cast<IAudioProcessor> (host->component);
	if (!host->processor) return -4;

	// Single-component plug-ins implement the controller themselves; otherwise create it from its class ID.
	host->controller = U::cast<IEditController> (host->component);
	if (!host->controller)
	{
		TUID controllerId;
		if (host->component->getControllerClassId (controllerId) == kResultOk &&
		    factory->createInstance (controllerId, IEditController::iid, reinterpret_cast<void**> (&host->controller)) == kResultOk && host->controller)
		{
			host->separateController = true;
			host->controller->initialize (&host->app);
			host->componentConnection = U::cast<IConnectionPoint> (host->component);
			host->controllerConnection = U::cast<IConnectionPoint> (host->controller);
			if (host->componentConnection && host->controllerConnection)
			{
				host->componentConnection->connect (host->controllerConnection);
				host->controllerConnection->connect (host->componentConnection);
			}
			MemoryStream state;
			if (host->component->getState (&state) == kResultOk)
			{
				state.seek (0, IBStream::kIBSeekSet, nullptr);
				host->controller->setComponentState (&state);
			}
		}
	}

	// Stereo main buses where the plug-in has them; every main bus active, auxiliary buses left off.
	std::vector<SpeakerArrangement> ins, outs;
	for (int32 i = 0; i < host->component->getBusCount (kAudio, kInput); ++i) ins.push_back (i == 0 ? SpeakerArr::kStereo : SpeakerArr::kEmpty);
	for (int32 i = 0; i < host->component->getBusCount (kAudio, kOutput); ++i) outs.push_back (i == 0 ? SpeakerArr::kStereo : SpeakerArr::kEmpty);
	host->processor->setBusArrangements (ins.data (), static_cast<int32> (ins.size ()), outs.data (), static_cast<int32> (outs.size ()));
	if (!ins.empty ()) host->component->activateBus (kAudio, kInput, 0, true);
	if (!outs.empty ()) host->component->activateBus (kAudio, kOutput, 0, true);
	if (host->component->getBusCount (kEvent, kInput) > 0) host->component->activateBus (kEvent, kInput, 0, true);

	ProcessSetup setup {kRealtime, kSample32, maxBlock, sampleRate};
	if (host->processor->setupProcessing (setup) != kResultOk) return -5;
	if (host->component->setActive (true) != kResultOk) return -6;
	host->data.prepare (*host->component, maxBlock, kSample32);
	host->data.inputParameterChanges = &host->inputChanges;
	host->data.inputEvents = &host->events;
	host->context.sampleRate = sampleRate;
	host->context.tempo = 120;
	host->context.timeSigNumerator = 4;
	host->context.timeSigDenominator = 4;
	host->context.state = ProcessContext::kTempoValid | ProcessContext::kTimeSigValid;
	host->data.processContext = &host->context;
	host->processor->setProcessing (true);

	if (host->controller)
		for (int32 i = 0; i < host->controller->getParameterCount (); ++i)
		{
			ParameterInfo info {};
			if (host->controller->getParameterInfo (i, info) == kResultOk) host->paramIds.push_back (info.id);
		}
	return 0;
}

SMTG_EXPORT_SYMBOL void vst3web_close ()
{
	if (!host) return;
	if (host->processor) host->processor->setProcessing (false);
	if (host->component) host->component->setActive (false);
	host->data.unprepare ();
	if (host->componentConnection && host->controllerConnection)
	{
		host->componentConnection->disconnect (host->controllerConnection);
		host->controllerConnection->disconnect (host->componentConnection);
	}
	if (host->separateController && host->controller) host->controller->terminate ();
	if (host->component) host->component->terminate ();
	delete host;
	host = nullptr;
}

// Channel count of the main input (dir 0) or output (dir 1) bus, or 0 if absent.
SMTG_EXPORT_SYMBOL int vst3web_channels (int dir)
{
	if (!host) return 0;
	const BusDirection d = dir ? kOutput : kInput;
	return host->component->getBusCount (kAudio, d) > 0 ? busInfo (kAudio, d, 0).channelCount : 0;
}

SMTG_EXPORT_SYMBOL int vst3web_has_events () { return host && host->component->getBusCount (kEvent, kInput) > 0; }

// Pointer to the 32-bit sample buffer of main bus channel `ch` (dir 0 input, 1 output).
SMTG_EXPORT_SYMBOL float* vst3web_buffer (int dir, int ch)
{
	if (!host) return nullptr;
	AudioBusBuffers* buses = dir ? host->data.outputs : host->data.inputs;
	const int32 count = dir ? host->data.numOutputs : host->data.numInputs;
	if (!buses || count < 1 || ch >= buses[0].numChannels) return nullptr;
	return buses[0].channelBuffers32[ch];
}

SMTG_EXPORT_SYMBOL int vst3web_process (int frames)
{
	if (!host) return -1;
	host->data.numSamples = frames;
	const tresult result = host->processor->process (host->data);
	host->context.projectTimeSamples += frames;
	host->inputChanges.clearQueue ();
	host->events.clear ();
	return result == kResultOk ? 0 : -2;
}

SMTG_EXPORT_SYMBOL int vst3web_param_count () { return host ? static_cast<int> (host->paramIds.size ()) : 0; }

// JSON: { id, title, units, steps, value, flags }
SMTG_EXPORT_SYMBOL const char* vst3web_param_info (int index)
{
	ParameterInfo info {};
	if (!host || !host->controller || host->controller->getParameterInfo (index, info) != kResultOk) return "null";
	text = "{\"id\":" + std::to_string (info.id) + ",\"title\":" + json (utf8 (info.title)) + ",\"units\":" + json (utf8 (info.units)) +
	       ",\"steps\":" + std::to_string (info.stepCount) + ",\"value\":" + std::to_string (host->controller->getParamNormalized (info.id)) +
	       ",\"flags\":" + std::to_string (info.flags) + "}";
	return text.c_str ();
}

SMTG_EXPORT_SYMBOL const char* vst3web_param_text (unsigned id, double value)
{
	String128 str {};
	text = host && host->controller && host->controller->getParamStringByValue (id, value, str) == kResultOk ? utf8 (str) : "";
	return text.c_str ();
}

// Sets a normalized (0..1) value on the controller and queues it for the processor's next block.
SMTG_EXPORT_SYMBOL void vst3web_param_set (unsigned id, double value)
{
	if (!host) return;
	if (host->controller) host->controller->setParamNormalized (id, value);
	int32 queueIndex = 0, pointIndex = 0;
	if (IParamValueQueue* queue = host->inputChanges.addParameterData (id, queueIndex)) queue->addPoint (0, value, pointIndex);
}

SMTG_EXPORT_SYMBOL void vst3web_note (int on, int pitch, float velocity)
{
	if (!host) return;
	Event e {};
	e.busIndex = 0;
	e.sampleOffset = 0;
	if (on)
	{
		e.type = Event::kNoteOnEvent;
		e.noteOn = {0, static_cast<int16> (pitch), 0.f, velocity, 0, -1};
	}
	else
	{
		e.type = Event::kNoteOffEvent;
		e.noteOff = {0, static_cast<int16> (pitch), velocity, -1, 0.f};
	}
	host->events.addEvent (e);
}

SMTG_EXPORT_SYMBOL void vst3web_tempo (double bpm) { if (host) host->context.tempo = bpm; }

} // extern "C"
