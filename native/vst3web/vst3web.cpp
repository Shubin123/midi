// vst3web: a minimal VST3 host compiled into the same WebAssembly module as a VST3 plug-in.
//
// Any VST3 plug-in whose source builds with the VST3 SDK can be linked with this file. The browser then
// talks to the plug-in through the plain C functions below, while this file drives the plug-in through
// the real VST3 interfaces (IPluginFactory, IComponent, IAudioProcessor, IEditController) exactly as a
// desktop host would. Uses the Steinberg VST3 SDK hosting helpers (MIT License).
//
// The page runs two instances of a module: one in an AudioWorklet that processes (role 1, audio), and one
// on the page's thread whose controller serves the parameters and, built with VST3WEB_GUI, the plug-in's
// own editor (role 2, editor). Each controller edit (IComponentHandler) goes to the page, which sends it to
// the audio instance; the processor's output parameters (meters) come back the other way; and the two halves'
// IConnectionPoint messages cross between instances, serialized, through the page. With role 0 (the default,
// as tests use it) one instance does both, its component and controller connected directly.

#include "pluginterfaces/base/funknownimpl.h"
#include "pluginterfaces/base/ipluginbase.h"
#include "pluginterfaces/vst/ivstaudioprocessor.h"
#include "pluginterfaces/vst/ivstcomponent.h"
#include "pluginterfaces/vst/ivsteditcontroller.h"
#include "pluginterfaces/vst/ivstevents.h"
#include "pluginterfaces/vst/ivstmessage.h"
#include "pluginterfaces/vst/ivstattributes.h"
#include "pluginterfaces/gui/iplugview.h"
#include "public.sdk/source/common/memorystream.h"
#include "public.sdk/source/vst/hosting/eventlist.h"
#include "public.sdk/source/vst/hosting/hostclasses.h"
#include "public.sdk/source/vst/hosting/parameterchanges.h"
#include "public.sdk/source/vst/hosting/processdata.h"

#include <map>
#include <string>
#include <vector>

#ifdef VST3WEB_GUI
#include "webplatform.h"
void vst3web_view_close_internal (); // the editor goes before the plug-in it shows
#endif

// What the page is told (module "vst3web", js/vst3-runtime.js): an edit from the controller (kind 0 begin,
// 1 perform, 2 end), a restart request, a message for the other instance, the editor's new size.
#define VST3WEB_IMPORT(name) __attribute__ ((import_module ("vst3web"), import_name (#name)))
extern "C" {
VST3WEB_IMPORT (edit) void vst3web_js_edit (int kind, unsigned id, double value);
VST3WEB_IMPORT (restart) void vst3web_js_restart (int flags);
VST3WEB_IMPORT (message) void vst3web_js_message (const unsigned char* data, int length);
VST3WEB_IMPORT (resize_view) int vst3web_js_resize_view (int width, int height);
}

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

/* ---- Messages between the two halves ---- */

// An attribute list that can be read back in full, so a message can be sent to the other instance.
class Attributes : public U::Implements<U::Directly<IAttributeList>>
{
public:
	struct Value { int type = 0; int64 i = 0; double f = 0; std::u16string s; std::vector<uint8> b; }; // type: 1 int, 2 float, 3 string, 4 binary
	std::map<std::string, Value> values;
	tresult PLUGIN_API setInt (AttrID id, int64 v) override { auto& x = values[id]; x = {}; x.type = 1; x.i = v; return kResultTrue; }
	tresult PLUGIN_API getInt (AttrID id, int64& v) override { auto x = find (id, 1); if (!x) return kResultFalse; v = x->i; return kResultTrue; }
	tresult PLUGIN_API setFloat (AttrID id, double v) override { auto& x = values[id]; x = {}; x.type = 2; x.f = v; return kResultTrue; }
	tresult PLUGIN_API getFloat (AttrID id, double& v) override { auto x = find (id, 2); if (!x) return kResultFalse; v = x->f; return kResultTrue; }
	tresult PLUGIN_API setString (AttrID id, const TChar* str) override
	{
		auto& x = values[id]; x = {}; x.type = 3;
		for (; str && *str; ++str) x.s.push_back (static_cast<char16_t> (*str));
		return kResultTrue;
	}
	tresult PLUGIN_API getString (AttrID id, TChar* str, uint32 sizeInBytes) override
	{
		auto x = find (id, 3);
		if (!x || sizeInBytes < sizeof (TChar)) return kResultFalse;
		auto n = std::min<size_t> (x->s.size (), sizeInBytes / sizeof (TChar) - 1);
		for (size_t k = 0; k < n; ++k) str[k] = static_cast<TChar> (x->s[k]);
		str[n] = 0;
		return kResultTrue;
	}
	tresult PLUGIN_API setBinary (AttrID id, const void* data, uint32 size) override
	{
		auto& x = values[id]; x = {}; x.type = 4;
		x.b.assign (static_cast<const uint8*> (data), static_cast<const uint8*> (data) + size);
		return kResultTrue;
	}
	tresult PLUGIN_API getBinary (AttrID id, const void*& data, uint32& size) override
	{
		auto x = find (id, 4);
		if (!x) return kResultFalse;
		data = x->b.data (); size = static_cast<uint32> (x->b.size ());
		return kResultTrue;
	}

private:
	Value* find (AttrID id, int type) { auto it = values.find (id); return it != values.end () && it->second.type == type ? &it->second : nullptr; }
};

class Message : public U::Implements<U::Directly<IMessage>>
{
public:
	FIDString PLUGIN_API getMessageID () override { return id.c_str (); }
	void PLUGIN_API setMessageID (FIDString mid) override { id = mid ? mid : ""; }
	IAttributeList* PLUGIN_API getAttributes () override { return attributes; }
	std::string id;
	IPtr<Attributes> attributes {owned (new Attributes)};
};

// The host's factory makes our messages, so they can be read back to be sent.
class WebHostApplication : public HostApplication
{
public:
	tresult PLUGIN_API createInstance (TUID cid, TUID iid, void** obj) override
	{
		if (FUnknownPrivate::iidEqual (cid, IMessage::iid) && FUnknownPrivate::iidEqual (iid, IMessage::iid))
		{
			*obj = static_cast<IMessage*> (new Message);
			return kResultTrue;
		}
		return HostApplication::createInstance (cid, iid, obj);
	}
};

// A message as bytes: the ID, then each attribute as key, type and value (strings as UTF-16 code units).
std::vector<uint8> serialize (IMessage* message)
{
	std::vector<uint8> out;
	auto put = [&] (const void* p, size_t n) { out.insert (out.end (), static_cast<const uint8*> (p), static_cast<const uint8*> (p) + n); };
	auto putU32 = [&] (uint32 v) { put (&v, 4); };
	auto putText = [&] (const std::string& t) { putU32 (static_cast<uint32> (t.size ())); put (t.data (), t.size ()); };
	putText (message->getMessageID () ? message->getMessageID () : "");
	auto attributes = dynamic_cast<Attributes*> (message->getAttributes ()); // ours, made by WebHostApplication
	putU32 (attributes ? static_cast<uint32> (attributes->values.size ()) : 0);
	if (!attributes) return out;
	for (auto& [key, v] : attributes->values)
	{
		putText (key);
		out.push_back (static_cast<uint8> (v.type));
		if (v.type == 1) put (&v.i, 8);
		else if (v.type == 2) put (&v.f, 8);
		else if (v.type == 3) { putU32 (static_cast<uint32> (v.s.size ())); put (v.s.data (), v.s.size () * 2); }
		else if (v.type == 4) { putU32 (static_cast<uint32> (v.b.size ())); put (v.b.data (), v.b.size ()); }
	}
	return out;
}
IPtr<Message> deserialize (const uint8* data, size_t length)
{
	auto message = owned (new Message);
	size_t at = 0;
	auto take = [&] (void* p, size_t n) { if (at + n > length) { at = length + 1; return false; } memcpy (p, data + at, n); at += n; return true; };
	auto takeU32 = [&] () { uint32 v = 0; take (&v, 4); return v; };
	auto takeText = [&] () { std::string t (takeU32 (), '\0'); take (t.data (), t.size ()); return t; };
	message->id = takeText ();
	for (uint32 n = takeU32 (); n-- && at <= length;)
	{
		auto key = takeText ();
		uint8 type = 0; take (&type, 1);
		auto& v = message->attributes->values[key];
		v.type = type;
		if (type == 1) take (&v.i, 8);
		else if (type == 2) take (&v.f, 8);
		else if (type == 3) { v.s.resize (takeU32 ()); take (v.s.data (), v.s.size () * 2); }
		else if (type == 4) { v.b.resize (takeU32 ()); take (v.b.data (), v.b.size ()); }
	}
	return message;
}

// Stands in for the other instance's connection point: what it is sent goes to the page.
class Bridge : public U::Implements<U::Directly<IConnectionPoint>>
{
public:
	tresult PLUGIN_API connect (IConnectionPoint*) override { return kResultTrue; }
	tresult PLUGIN_API disconnect (IConnectionPoint*) override { return kResultTrue; }
	tresult PLUGIN_API notify (IMessage* message) override
	{
		if (!message) return kInvalidArgument;
		auto bytes = serialize (message);
		vst3web_js_message (bytes.data (), static_cast<int> (bytes.size ()));
		return kResultTrue;
	}
};

// Edits made in the controller (its editor moving a control): the page sends them to the processor.
class ComponentHandler : public U::Implements<U::Directly<IComponentHandler>>
{
public:
	tresult PLUGIN_API beginEdit (ParamID id) override { vst3web_js_edit (0, id, 0); return kResultOk; }
	tresult PLUGIN_API performEdit (ParamID id, ParamValue value) override { vst3web_js_edit (1, id, value); return kResultOk; }
	tresult PLUGIN_API endEdit (ParamID id) override { vst3web_js_edit (2, id, 0); return kResultOk; }
	tresult PLUGIN_API restartComponent (int32 flags) override { vst3web_js_restart (flags); return kResultOk; }
};

int role = 0; // 0 both halves here, 1 the audio half, 2 the editor half

struct Host
{
	WebHostApplication app;
	IPtr<IComponent> component;
	IPtr<IAudioProcessor> processor;
	IPtr<IEditController> controller;
	IPtr<IConnectionPoint> componentConnection, controllerConnection;
	HostProcessData data;
	ParameterChanges inputChanges {64}, outputChanges {64};
	IPtr<Bridge> bridge {owned (new Bridge)};
	IPtr<ComponentHandler> handler {owned (new ComponentHandler)};
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
			// Both halves here are connected to each other; split across instances, each to the bridge.
			if (role == 1 && host->componentConnection) host->componentConnection->connect (host->bridge);
			else if (role == 2 && host->controllerConnection) host->controllerConnection->connect (host->bridge);
			else if (host->componentConnection && host->controllerConnection)
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
	host->data.outputParameterChanges = &host->outputChanges;
	host->data.inputEvents = &host->events;
	host->context.sampleRate = sampleRate;
	host->context.tempo = 120;
	host->context.timeSigNumerator = 4;
	host->context.timeSigDenominator = 4;
	host->context.state = ProcessContext::kTempoValid | ProcessContext::kTimeSigValid;
	host->data.processContext = &host->context;
	host->processor->setProcessing (true);

	if (host->controller)
		host->controller->setComponentHandler (host->handler);
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
#ifdef VST3WEB_GUI
	vst3web_view_close_internal ();
#endif
	if (role == 1 && host->componentConnection) host->componentConnection->disconnect (host->bridge);
	else if (role == 2 && host->controllerConnection) host->controllerConnection->disconnect (host->bridge);
	else if (host->componentConnection && host->controllerConnection)
	{
		host->componentConnection->disconnect (host->controllerConnection);
		host->controllerConnection->disconnect (host->componentConnection);
	}
	if (host->controller) host->controller->setComponentHandler (nullptr);
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
	host->outputChanges.clearQueue ();
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

// Which half this instance is (0 both, 1 audio, 2 editor); set before vst3web_open.
SMTG_EXPORT_SYMBOL void vst3web_set_role (int r) { role = r; }

// The processor's output parameters from the last block (meters and the like): how many, and each one's ID
// and last value.
SMTG_EXPORT_SYMBOL int vst3web_out_count () { return host ? host->outputChanges.getParameterCount () : 0; }
SMTG_EXPORT_SYMBOL unsigned vst3web_out_id (int i)
{
	auto q = host ? host->outputChanges.getParameterData (i) : nullptr;
	return q ? q->getParameterId () : 0;
}
SMTG_EXPORT_SYMBOL double vst3web_out_value (int i)
{
	auto q = host ? host->outputChanges.getParameterData (i) : nullptr;
	ParamValue v = 0; int32 offset = 0;
	if (q && q->getPointCount () > 0) q->getPoint (q->getPointCount () - 1, offset, v);
	return v;
}
// A value the processor reported, or the other instance's controller set: for this controller (and its
// editor) only, not queued for this instance's processor.
SMTG_EXPORT_SYMBOL void vst3web_controller_set (unsigned id, double value)
{
	if (host && host->controller) host->controller->setParamNormalized (id, value);
}
// A message from the other instance (vst3web_js_message's bytes), for this instance's half.
SMTG_EXPORT_SYMBOL void vst3web_message_deliver (const unsigned char* data, int length)
{
	if (!host || !data) return;
	auto message = deserialize (data, static_cast<size_t> (length));
	if (role == 1 && host->componentConnection) host->componentConnection->notify (message);
	else if (role == 2 && host->controllerConnection) host->controllerConnection->notify (message);
}

#ifdef VST3WEB_GUI
} // extern "C"

/* ---- The plug-in's own editor (IPlugView), drawn by VSTGUI's web platform (native/vstgui-web) ---- */

namespace {
// The platform type a web host offers: an HTML canvas. VSTGUI's editors built here also accept the X11 one,
// which the web platform stands in for, so plug-ins that only know the desktop types still open.
constexpr FIDString kPlatformTypeHTMLCanvas = "HTMLCanvas";

class PlugFrame : public U::Implements<U::Directly<IPlugFrame>>
{
public:
	// The editor asks to be another size: the page sizes its canvas to it (it always can), and the view is told.
	tresult PLUGIN_API resizeView (IPlugView* view, ViewRect* r) override
	{
		if (!view || !r) return kInvalidArgument;
		vst3web_js_resize_view (r->getWidth (), r->getHeight ());
		view->onSize (r);
		return kResultTrue;
	}
};
IPtr<IPlugView> view;
IPtr<PlugFrame> plugFrame;
} // namespace

void vst3web_view_close_internal ()
{
	if (!view) return;
	view->removed ();
	view->setFrame (nullptr);
	view = nullptr;
}

extern "C" {

// Opens the editor; size out = width, height, and 1 if it can be resized. Returns 0, or -1 no controller,
// -2 no editor (createView returned nothing), -3 no platform type we offer, -4 it wouldn't attach.
SMTG_EXPORT_SYMBOL int vst3web_view_open (int* size)
{
	vst3web_view_close_internal ();
	if (!host || !host->controller) return -1;
	view = owned (host->controller->createView (ViewType::kEditor));
	if (!view) return -2;
	FIDString type = view->isPlatformTypeSupported (kPlatformTypeHTMLCanvas) == kResultTrue ? kPlatformTypeHTMLCanvas
	                 : view->isPlatformTypeSupported (kPlatformTypeX11EmbedWindowID) == kResultTrue ? kPlatformTypeX11EmbedWindowID : nullptr;
	if (!type) { view = nullptr; return -3; }
	if (!plugFrame) plugFrame = owned (new PlugFrame);
	view->setFrame (plugFrame);
	if (view->attached (plugFrame.get (), type) != kResultTrue) { view = nullptr; return -4; } // any non-null parent: the page is the window
	ViewRect r {};
	view->getSize (&r);
	size[0] = r.getWidth (); size[1] = r.getHeight (); size[2] = view->canResize () == kResultTrue;
	return 0;
}
// The window resized the editor: the size it takes (it may hold to its own limits), out as width, height.
SMTG_EXPORT_SYMBOL int vst3web_view_resize (int width, int height, int* size)
{
	if (!view) return -1;
	ViewRect r (0, 0, width, height);
	if (view->checkSizeConstraint (&r) != kResultTrue) view->getSize (&r);
	view->onSize (&r);
	size[0] = r.getWidth (); size[1] = r.getHeight ();
	return 0;
}
SMTG_EXPORT_SYMBOL int vst3web_view_draw (double scale) { return view ? vstgui_web_draw (scale) : 0; }
SMTG_EXPORT_SYMBOL void vst3web_view_mouse (int type, double x, double y, int buttons, int modifiers, int clicks) { if (view) vstgui_web_mouse (type, x, y, buttons, modifiers, clicks); }
SMTG_EXPORT_SYMBOL void vst3web_view_wheel (double x, double y, double dx, double dy, int modifiers) { if (view) vstgui_web_wheel (x, y, dx, dy, modifiers); }
SMTG_EXPORT_SYMBOL int vst3web_view_key (int down, int virt, unsigned character, int modifiers, int repeat) { return view ? vstgui_web_key (down, virt, character, modifiers, repeat) : 0; }
SMTG_EXPORT_SYMBOL void vst3web_view_timer (int id) { vstgui_web_timer (id); }
SMTG_EXPORT_SYMBOL void vst3web_view_focus (int on) { if (view) vstgui_web_focus (on); }
SMTG_EXPORT_SYMBOL void vst3web_view_close () { vst3web_view_close_internal (); }
#endif // VST3WEB_GUI

} // extern "C"
