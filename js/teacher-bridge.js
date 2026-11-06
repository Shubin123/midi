// AI music theory teacher: a side panel that follows the notes you play. Note names and the held chord show
// instantly, scale/mode and chords once a phrase ends (all local), and then a model explains the phrase.
// The panel has two tabs: Lesson (the conversation) and Provider (where answers come from). Each provider is
// a separate, direct connection: on-device (no sign-in), OpenRouter (sign-in), or a provider's own API key
// (Groq, Cerebras, Gemini, Mistral, OpenAI, or a custom endpoint). On-device runs two models that work as
// System 1 and System 2: Laya, a fast decision model, picks the next coaching step the moment a phrase ends
// (js/laya.js, js/coach.js), and Qwen thinks through explanations and questions. Fast mode stops at Laya's
// step; Slow mode also has the System 2 model think each phrase through. Suggested notes and chords play
// through the synth and light up the keyboard. The Talk button turns on voice: speak a question and hear the
// teacher answer (js/voice.js). The Course tab teaches lessons adapted from Open Music Theory (js/lessons.js):
// each one explains an idea, plays an example and checks a task from what you play. A first unit teaches the
// workspace itself, and a second tempo and rhythm, and how System 1 and System 2 split the work the same way
// (js/rhythm-lessons.js). Every widget and plug-in window gets a 🎓 button that opens its guide (shown when
// switched on in Settings), and the model sees the widgets and their settings (js/workspace.js) so it can
// point at controls and change them when asked. Conversations are kept in the browser (js/conversations.js). The panel only needs the synth's `synth:note`
// events and `window.synth`, so loading this module is the whole integration.
import { PhraseTracker, NOTE_NAMES, detectChord, pitchClassName, fitToKeys, followKeys, KEYS_LOW } from './pitch-analyzer.js';
import { AiTeacher } from './ai-teacher.js';
import { el } from './plugin-ui.js';
import { LocalEngine, MODELS as LOCAL_MODELS, DEFAULT_MODEL as LOCAL_DEFAULT, webgpuAvailable } from './local-model.js';
import { LayaCoach, LAYA_MB } from './laya.js';
import { buildMove, describePlayed } from './coach.js';
import { LESSONS, UNITS, OMT, Attempt, explainPrompt } from './lessons.js';
import { RHYTHM_UNIT, RHYTHM_LESSONS } from './rhythm-lessons.js';
import { WORKSPACE_UNIT, WORKSPACE_LESSONS, guideFor, KEYWORDS, profiles } from './workspace-guide.js';
import { learnPlugin, cachedProfile, keepProfile, summarize, KINDS, ROLES } from './plugin-profile.js';
import * as ws from './workspace.js';
import { Conversations, describeConversation } from './conversations.js';
import { modelCacheInfo, clearModelCache, formatBytes } from './model-cache.js';
import { answer as systemOneAnswer, nextTip, isSoundControl } from './system-one.js';
import { meetRequest } from './requests.js';
import { readCommand, pluginWords } from './commands.js';
import { timing } from './timing-widget.js';
import { rhythmSummary, describeRhythm, rhythmMessage, learn as learnTiming, newProfile, issues, exerciseOptions, exercise, EXERCISES, NUDGES, NUDGE_GAP_MS, nudgeText, patternSteps } from './timing.js';
import { Voice, canListen, canSpeak, ENGINES as VOICE_ENGINES, loadEngine, BROWSER, SPEED as VOICE_SPEED, speedFrom } from './voice.js';
import { PROVIDERS, GROUPS, SYSTEM_ONE, NO_SYSTEM_TWO, providerById, getProviderId, setProviderId, getKey, setKey, clearKey, getModelFor, setModelFor, getBase, setBase, engineFor, listModels, pickModel, fetchOpenRouterModels } from './providers.js';
import { signIn, completeSignIn } from './ai-auth.js';
import { read, save } from './storage.js';
import { CLAP, listening, keyAndScale } from './listening.js';
import { readIntent, makePhrase, scoreSingBack } from './voice-mode.js';
import { SPEECH_LOCAL_KEY, AUDIO_TO_PROVIDER_KEY } from './settings.js';
import { encodeAudio } from './audio-files.js';
import { Agent, ACTIONS, definitions as agentTools, midiOf as midiOfName } from './agent-actions.js';
import { chordMidi, scaleRunMidi } from './pitch-analyzer.js';
import { controllers } from './controllers/runtime.js';
import { controllerContext, readControllerCommand } from './controllers/agent.js';
import { CONTROLLER_UNIT, CONTROLLER_LESSONS, lessonState } from './controllers/lessons.js';

// Notes the player struck or sang; the sequencer, looper and the teacher's own playback are not analysed.
const PLAYED = /^(midi|computer|mouse|touch|audio)/; // audio: sung or played into the microphone (js/listening.js)
const toNote = midi => NOTE_NAMES[midi % 12] + Math.floor(midi / 12); // the synth calls MIDI 60 "C5"
const MAX_MESSAGES = 200;
const host = url => url.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
// The course: the workspace first, then tempo and rhythm, then music theory from Open Music Theory.
const COURSE = [...WORKSPACE_LESSONS, ...RHYTHM_LESSONS, ...CONTROLLER_LESSONS, ...LESSONS], COURSE_UNITS = [WORKSPACE_UNIT, RHYTHM_UNIT, CONTROLLER_UNIT, ...UNITS];
const courseLesson = id => COURSE.find(l => l.id === id) || null;
const nextInCourse = id => COURSE[COURSE.findIndex(l => l.id === id) + 1] || null;
const isWorkspace = l => l?.unit === WORKSPACE_UNIT;
const isRhythm = l => l?.unit === RHYTHM_UNIT;
const isController = l => l?.unit === CONTROLLER_UNIT; // checked from what the controller did (js/controllers/lessons.js)
// Questions about the controller get it described to the model ([CONTROLLER]).
const ABOUT_CONTROLLER = /\b(knobs?|faders?|pads?|encoders?|controller|minilab|shift|strips?|pedal|preset|map(ping)?|bank|arp(eggiator)?|screen)\b/i;
// A phrase analysis cut down to what phraseMessage() reads, for keeping in a saved conversation.
const compact = a => ({ noteOns: a.noteOns.slice(0, 48).map(n => ({ note: n.note })), noteCount: a.noteCount, durationMs: a.durationMs, pitchClasses: a.pitchClasses, scales: a.scales.slice(0, 1).map(({ tonicName, scaleName, score }) => ({ tonicName, scaleName, score })), chords: a.chords.map(c => ({ best: { chordName: c.best.chordName } })) });
// Questions that are about the app rather than the music get the workspace described to the model.
const ABOUT_APP = /widget|plug-?in|effect|knob|slider|button|setting|sound|patch|how do i|where (is|do)|what does|turn (on|off)|change|set /i;
// The voice talk mode starts with: the best female voice of the three engines. Scored on the same coaching
// lines with DNSMOS, Pocket TTS's Anna tied for the top (3.44, with Piper's Amy; Supertonic's F1 3.41), and
// she is CC BY 4.0, a 134 MB download, and runs on one CPU thread, leaving the GPU to Laya and Qwen.
const DEFAULT_VOICE = { engine: 'pocket', voice: 'anna' };
// Requests System 1 can't meet, since it only chooses from what is written: composing or playing something
// particular, or changing the last example. With System 2 connected these go straight to it.
// Requests for the teacher to run something as an agent (set up a lesson, an exercise, a practice track): with
// System 2 connected they go straight to it, whose tools can do several things at once, before System 1 reads a
// single setting out of them.
const AGENT = /\b(lessons?|exercises?|practi[cs]e|backing (track|loop)|coach me|set (it |everything |this )?up|set up|how did i do)\b/i;
const COMPOSE = /\b(play|make|write|compose|improvise|give me|create|show me)\b[^.?!]*\b(lick|riff|melody|progression|chords?|song|tune|groove|bass ?line|arpeggio|scale|example|it|that|this|something)\b|\b(longer|shorter|faster|slower|again|same|another|instead|variation)\b/i;


const STYLE = `
:root{--teacher-width:min(360px,100vw)}
#teacher-panel{position:fixed;right:0;top:0;bottom:0;width:var(--teacher-width);box-sizing:border-box;display:flex;flex-direction:column;z-index:10000;background:var(--primary-surface-color);color:var(--text-color);border-left:1px solid var(--border-color);box-shadow:-8px 0 30px #0005;font-size:13px;line-height:1.45;transition:transform .2s,visibility .2s}
#teacher-panel.collapsed{transform:translateX(100%);visibility:hidden}
#teacher-panel .tp-resize{position:absolute;left:-5px;top:0;bottom:0;width:10px;cursor:ew-resize;z-index:3;touch-action:none}
#teacher-panel .tp-resize:hover,#teacher-panel .tp-resize:focus-visible,#teacher-panel .tp-resize.dragging{background:linear-gradient(to right,transparent 4px,var(--accent-color) 4px 6px,transparent 6px);outline:none}
#teacher-panel *{box-sizing:border-box}
#teacher-panel button{font:inherit;font-size:12px;border:1px solid var(--border-color);border-radius:6px;background:var(--secondary-surface-color);color:var(--text-color);padding:6px 10px;cursor:pointer}
#teacher-panel button:disabled{opacity:.5;cursor:default}
#teacher-panel .tp-primary{background:var(--accent-color);color:var(--bg-color);border-color:var(--accent-color);font-weight:600}
#teacher-panel .tp-link{background:none;border:0;padding:0;color:var(--accent-color);text-decoration:underline;font-size:11px}
#teacher-panel select,#teacher-panel input[type=text],#teacher-panel input[type=password]{font:inherit;font-size:13px;background:var(--bg-color);border:1px solid var(--border-color);color:var(--text-color);padding:7px 8px;border-radius:6px;width:100%;min-width:0;margin:0}
#teacher-panel a{color:var(--accent-color)}
#teacher-panel label{margin:0;font-size:inherit;transition:none}
#teacher-panel label input[type=checkbox],#teacher-panel label input[type=radio]{transform:none;margin-right:0}

#teacher-panel .tp-head{padding:12px 14px 10px;border-bottom:1px solid var(--border-color);display:flex;flex-direction:column;gap:6px}
#teacher-panel .tp-title-row{display:flex;justify-content:space-between;align-items:center}
#teacher-panel h2{margin:0;font-size:15px;color:var(--accent-color)}
#teacher-panel .tp-status{font-size:11px;padding:2px 8px;border-radius:10px;border:1px solid var(--border-color);color:var(--text-muted-color);white-space:nowrap}
#teacher-panel .tp-status.ready{color:#6bcb77;border-color:#6bcb77}
#teacher-panel .tp-status.thinking,#teacher-panel .tp-status.loading{color:var(--accent-color);border-color:var(--accent-color)}
#teacher-panel .tp-summary{display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;text-align:left;background:color-mix(in srgb,var(--bg-color) 45%,transparent)}
#teacher-panel .tp-summary span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#teacher-panel .tp-summary b{font-weight:600}
#teacher-panel .tp-summary .tp-change{color:var(--accent-color);flex:none;font-size:11px}

#teacher-panel .tp-tabs{display:flex;border-bottom:1px solid var(--border-color)}
#teacher-panel .tp-tabs button{flex:1;border:0;border-radius:0;background:none;padding:9px;color:var(--text-muted-color);border-bottom:2px solid transparent;font-weight:600}
#teacher-panel .tp-tabs button[aria-selected=true]{color:var(--text-color);border-bottom-color:var(--accent-color)}
#teacher-panel .tp-view{flex:1;min-height:0;display:flex;flex-direction:column}
#teacher-panel .tp-view[hidden]{display:none}

#teacher-panel .tp-live{display:flex;align-items:baseline;gap:8px;padding:8px 14px;background:var(--secondary-surface-color);border-bottom:1px solid var(--border-color);min-height:38px}
#teacher-panel .tp-live-note{font-size:18px;font-weight:700;min-width:26px}
#teacher-panel .tp-live-detail{font:11px monospace;color:var(--text-muted-color);flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#teacher-panel .tp-live[hidden]{display:none}
#teacher-panel .tp-chip{font-size:11px;font-weight:600;padding:2px 8px;border-radius:10px;background:var(--accent-color);color:var(--bg-color)}
#teacher-panel .tp-chip[hidden]{display:none}
#teacher-panel .tp-messages{flex:1;overflow-y:auto;padding:12px 14px}
#teacher-panel .tp-empty{color:var(--text-muted-color);font-size:12px;padding:14px;border:1px dashed var(--border-color);border-radius:8px;display:flex;flex-direction:column;gap:10px;align-items:flex-start}
#teacher-panel .teacher-msg{margin-bottom:10px;padding:8px 10px;border-radius:8px;overflow-wrap:anywhere;white-space:pre-line;border-left:3px solid var(--border-color);background:color-mix(in srgb,var(--bg-color) 50%,transparent)}
#teacher-panel .teacher-msg.local{font-size:12px;color:var(--text-muted-color);white-space:normal}
#teacher-panel .teacher-msg.local strong{color:var(--text-color);display:block}
#teacher-panel .teacher-msg.local .tp-dim{font:11px monospace;display:block;margin-top:2px}
#teacher-panel .teacher-msg.teacher{border-left-color:var(--accent-color)}
#teacher-panel .teacher-msg.user{border-left-color:var(--text-muted-color);text-align:right}
#teacher-panel .teacher-msg.info{font-size:12px;color:var(--text-muted-color);border-left-color:#6bcb77}
#teacher-panel .teacher-msg.error{border-left-color:#ff6b6b;color:#ff6b6b;font-size:12px}
#teacher-panel .teacher-msg button{display:block;margin-top:6px}
#teacher-panel .tp-foot{border-top:1px solid var(--border-color);padding:8px 10px 10px;display:flex;flex-direction:column;gap:8px}
#teacher-panel .tp-foot-row{display:flex;justify-content:space-between;align-items:center;font-size:12px;color:var(--text-muted-color)}
#teacher-panel .tp-foot-row label{display:flex;align-items:center;gap:6px;cursor:pointer}
#teacher-panel .tp-foot-row input{accent-color:var(--accent-color);margin:0}
#teacher-panel .tp-ask{display:flex;gap:6px}
#teacher-panel .tp-talk{flex:none}
#teacher-panel .tp-talk[aria-pressed=true]{background:#e76f51;border-color:#e76f51;color:#fff;font-weight:600}
#teacher-panel .tp-talk.listening{animation:tp-pulse 1.4s ease-in-out infinite}
@keyframes tp-pulse{0%,100%{box-shadow:0 0 0 0 #e76f5199}50%{box-shadow:0 0 0 5px #e76f5100}}
#teacher-panel .tp-talk-note{margin:0;font-size:11px;color:var(--text-muted-color)}
#teacher-panel .tp-talk-note[hidden]{display:none}
#teacher-panel .tp-mode{display:flex;align-items:center;gap:8px;font-size:11px;color:var(--text-muted-color)}
#teacher-panel .tp-mode[hidden]{display:none}
#teacher-panel .tp-seg{display:inline-flex;border:1px solid var(--border-color);border-radius:6px;overflow:hidden;flex:none}
#teacher-panel .tp-seg button{border:0;border-radius:0;padding:5px 12px}
#teacher-panel .tp-seg button[aria-checked=true]{background:var(--accent-color);color:var(--bg-color);font-weight:600}
#teacher-panel .tp-who{display:block;font-size:10px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--text-muted-color);margin-bottom:3px}
#teacher-panel .teacher-msg.coach{border-left-color:#f4a261}
#teacher-panel .tp-msg-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
#teacher-panel .teacher-msg .tp-msg-actions button{display:inline-block;margin:0}

#teacher-panel .teacher-msg.lesson{border-left-color:#9b8cff;white-space:normal}
#teacher-panel .teacher-msg.lesson strong{display:block;margin-bottom:4px;color:var(--text-color)}
#teacher-panel .teacher-msg.lesson p{margin:0 0 6px}
#teacher-panel .tp-task{font-weight:600}
#teacher-panel .teacher-msg.lesson a{font-size:11px}
#teacher-panel .teacher-msg.passed{border-left-color:#6bcb77}
#teacher-panel .tp-lesson-bar{display:flex;align-items:center;gap:8px;padding:6px 14px;font-size:12px;border-bottom:1px solid var(--border-color);background:color-mix(in srgb,#9b8cff 14%,transparent)}
#teacher-panel .tp-lesson-bar[hidden]{display:none}
#teacher-panel .tp-lesson-bar span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#teacher-panel .tp-lesson-bar button{flex:none;padding:3px 8px;font-size:11px}
#teacher-panel .tp-course-view{overflow-y:auto;padding:12px 14px 16px}
#teacher-panel .tp-lesson-item{display:flex;gap:10px;align-items:center;width:100%;text-align:left;margin-bottom:4px;background:color-mix(in srgb,var(--bg-color) 35%,transparent)}
#teacher-panel .tp-lesson-item.current{border-color:var(--accent-color)}
#teacher-panel .tp-lesson-n{flex:none;width:22px;height:22px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;font-size:11px;border:1px solid var(--border-color);color:var(--text-muted-color)}
#teacher-panel .tp-lesson-item.done .tp-lesson-n{background:#6bcb77;border-color:#6bcb77;color:#0b1a10}
#teacher-panel .tp-credit{margin:14px 0 0;font-size:11px;color:var(--text-muted-color)}
#teacher-panel .teacher-msg.guide{border-left-color:#f4a261;white-space:normal}
#teacher-panel .teacher-msg.guide strong{display:block;margin-bottom:4px;color:var(--text-color)}
#teacher-panel .teacher-msg.guide p{margin:0 0 6px}
#teacher-panel .tp-steps{margin:0 0 6px;padding-left:18px}
#teacher-panel .tp-steps li{margin-bottom:4px}
#teacher-panel .teacher-msg .tp-steps button{display:inline-block;margin:0 0 0 6px;padding:1px 7px;font-size:11px}
#teacher-panel .teacher-msg.rhythm{border-left-color:#6bcb77;white-space:normal}
#teacher-panel .teacher-msg.rhythm p{margin:6px 0 0}
#teacher-panel .teacher-msg.rhythm .tp-fix{font-weight:600}
#teacher-panel .tp-grid{display:flex;flex-direction:column;gap:3px;margin-top:6px}
#teacher-panel .tp-bar{display:grid;grid-template-columns:repeat(16,1fr);gap:2px}
#teacher-panel .tp-bar span{height:12px;border-radius:2px;background:color-mix(in srgb,var(--text-muted-color) 18%,transparent)}
#teacher-panel .tp-bar span.beat{background:color-mix(in srgb,var(--text-muted-color) 34%,transparent)}
#teacher-panel .tp-bar span.hit{background:var(--accent-color)}
#teacher-panel .tp-bar span.hit.good{background:#6bcb77}#teacher-panel .tp-bar span.hit.ok{background:#f4a261}#teacher-panel .tp-bar span.hit.off{background:#ff6b6b}
#teacher-panel .tp-exercise-bar{display:flex;align-items:center;gap:8px;padding:6px 14px;font-size:12px;border-bottom:1px solid var(--border-color);background:color-mix(in srgb,#6bcb77 14%,transparent)}
#teacher-panel .tp-exercise-bar[hidden]{display:none}
#teacher-panel .tp-exercise-bar span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#teacher-panel .tp-exercise-bar button{flex:none;padding:3px 8px;font-size:11px}
#teacher-panel .tp-habits{font-size:11px;color:var(--text-muted-color);margin:4px 0 8px}
#teacher-panel .teacher-msg.s1{border-left-color:#f4a261;white-space:normal}
#teacher-panel .teacher-msg.change{font-size:12px;border-left-color:var(--accent-color);white-space:normal}
#teacher-panel .teacher-msg.agent{font-size:12px;white-space:normal}
#teacher-panel .tp-ptt{flex:none}
#teacher-panel .tp-ptt[hidden]{display:none}
#teacher-panel .tp-ptt.held{background:#e76f51;border-color:#e76f51;color:#fff}
#teacher-panel .tp-sing{display:flex;flex-wrap:wrap;gap:4px;margin:4px 0 6px}
#teacher-panel .tp-sing-note{font:600 11px Poppins,sans-serif;padding:2px 7px;border-radius:10px;border:1px solid var(--border-color)}
#teacher-panel .tp-sing-note.good{border-color:#6bcb77;color:#6bcb77}
#teacher-panel .tp-sing-note.off{border-color:#f4a261;color:#f4a261}
#teacher-panel .tp-sing-note.missed{opacity:.6}
#teacher-panel .teacher-msg.agent.suggest{border-left-color:#9aa5b1;border-left-style:dashed}
#teacher-panel .teacher-msg.agent.confirm{border-left-color:#f4a261}
#teacher-panel .tp-history{width:auto;max-width:150px;font-size:11px;padding:4px 6px}
#teacher-panel .tp-storage{margin-top:16px;border-top:1px solid var(--border-color);padding-top:4px;display:flex;flex-direction:column;gap:6px}
#teacher-panel .tp-storage .tp-row{justify-content:space-between}
.widget-header .teach-btn{font-size:13px}
.teach-highlight{outline:3px solid var(--accent-color)!important;outline-offset:3px;border-radius:6px;animation:teach-pulse 1s ease-in-out 3}
@keyframes teach-pulse{50%{outline-color:transparent}}

#teacher-panel .tp-provider-view{overflow-y:auto;padding:12px 14px 16px}
#teacher-panel .tp-intro{margin:0 0 4px;font-size:12px;color:var(--text-muted-color)}
#teacher-panel .tp-speed span{display:flex;justify-content:space-between}
#teacher-panel .tp-speed input{width:100%;margin:12px 0 10px;accent-color:var(--accent-color)}
#teacher-panel .tp-layer-title{margin:16px 0 8px;font-size:12px;font-weight:700;color:var(--accent-color)}
#teacher-panel .tp-group-title{margin:14px 0 6px;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--text-muted-color)}
#teacher-panel .tp-card{border:1px solid var(--border-color);border-radius:8px;margin-bottom:6px;background:color-mix(in srgb,var(--bg-color) 35%,transparent)}
#teacher-panel .tp-card.selected{border-color:var(--accent-color)}
#teacher-panel .tp-card-head{display:flex;gap:10px;align-items:flex-start;padding:9px 10px;cursor:pointer}
#teacher-panel .tp-card-head input{margin:3px 0 0;accent-color:var(--accent-color)}
#teacher-panel .tp-card-text{display:flex;flex-direction:column;gap:2px;min-width:0}
#teacher-panel .tp-card-name{display:flex;flex-wrap:wrap;gap:6px;align-items:center;font-weight:600;color:var(--text-color)}
#teacher-panel .tp-card-meta{font-size:11px;color:var(--text-muted-color)}
#teacher-panel .tp-badge{font-size:10px;font-weight:600;padding:1px 6px;border-radius:8px;border:1px solid var(--border-color);color:var(--text-muted-color)}
#teacher-panel .tp-badge.free{border-color:#6bcb77;color:#6bcb77}
#teacher-panel .tp-badge.on{background:#6bcb77;border-color:#6bcb77;color:#0b1a10}
#teacher-panel .tp-badge.saved{border-color:var(--accent-color);color:var(--accent-color)}
#teacher-panel .tp-card-body{padding:2px 10px 12px 34px;display:flex;flex-direction:column;gap:8px}
#teacher-panel .tp-card-body[hidden]{display:none}
#teacher-panel .tp-field{display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-muted-color)}
#teacher-panel .tp-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap}
#teacher-panel .tp-row .tp-primary{flex:1}
#teacher-panel .tp-note{margin:0;font-size:11px;color:var(--text-muted-color)}
#teacher-panel .tp-card-status{margin:0;font-size:11px;min-height:0}
#teacher-panel .tp-card-status.ok{color:#6bcb77}
#teacher-panel .tp-card-status.bad{color:#ff6b6b}
#teacher-panel details summary{font-size:11px;color:var(--text-muted-color);cursor:pointer}
#teacher-panel details[open] summary{margin-bottom:6px}
#teacher-panel progress{width:100%;height:6px}

.teacher-toggle{position:fixed;top:50%;right:min(calc(var(--teacher-width) + 10px),calc(100vw - 36px));transform:translateY(-50%);z-index:10001;width:26px;height:56px;padding:0;border:1px solid var(--border-color);border-radius:8px;box-shadow:0 4px 14px #0005;background:var(--primary-surface-color);color:var(--text-color);cursor:pointer;transition:right .2s}
html:not(.teacher-open) .teacher-toggle{right:10px} /* it floats clear of the edge, and of the panel when open */
html:not(.teacher-off) body{padding-right:56px} /* a gutter for the pull tab (10 px from the edge, 26 px wide, 20 px clear of the widgets) */
@media(max-width:600px){html:not(.teacher-off) body{padding-right:46px}}
html.teacher-off #teacher-panel,html.teacher-off .teacher-toggle,html.teacher-off .teach-btn{display:none!important} /* switched off in Settings */
#keyboard .teacher-hint{box-shadow:inset 0 -14px 0 var(--accent-color)}
@media(min-width:900px){
 html.teacher-open body{margin-right:var(--teacher-width)}
 html.teacher-open .widget-menu{right:calc(24px + var(--teacher-width))}
 html.teacher-open .site-credits{right:calc(15px + var(--teacher-width))!important}
}`;

export class TeacherBridge {
 constructor() {
  this.teacher = new AiTeacher();
  this.tracker = new PhraseTracker(a => this._onPhrase(a), { gapMs: 800 });
  this.panel = null;
  this.autoAnalyze = read('teacher-auto-v1', true);
  // The teacher as an agent (js/agent-actions.js): its changes are made at once while "Agent can act" is on,
  // and offered to the student as suggestions while it is off. Undo for each is kept here, by entry, for the
  // session (a reloaded conversation shows what was done, without Undo).
  this.agentActs = read('teacher-agent-acts-v1', true);
  this._undos = new Map();
  this.agent = new Agent({ canAct: () => this.agentActs, show: e => this._agentShow(e), env: {
   play: (steps, bpm, label) => this._playSteps(steps, bpm, label), chordMidi: c => chordMidi(c), scaleRun: sc => scaleRunMidi(sc.tonic, sc.scaleName),
   exercise: () => this.exercise, setExercise: ex => this._setExercise(ex), singBack: opts => this._singBack(opts),
   lightKeys: (keys, seconds) => this._lightKeys(keys, seconds),
   performance: () => this.convo.current.entries.filter(e => e.kind === 'local' || e.kind === 'rhythm').slice(-4).map(e => (e.kind === 'local' ? `phrase: ${e.title}${e.chords ? `, chords ${e.chords}` : ''} (${e.detail})` : `rhythm: ${e.bars.join(' | ')}; ${e.text} ${e.fix}`)),
  } });
  this._phraseQueue = []; this._processing = false;
  this._timers = []; this._sounding = new Set();
  this._keysLow = KEYS_LOW; // the bottom C of the student's 25 keys; examples play there
  this._active = null; // { id, model } of the connected provider
  this._loading = false;
  this._selected = getProviderId(); // the provider card open in the Provider tab
  this.mode = read('teacher-mode-v1', 'fast'); // 'fast': System 1 only on phrases; 'slow': System 2 thinks too
  this.laya = null; this._localEngine = null; this._coachHistory = [];
  this._lastNoteAt = 0; this._askedAt = 0; // a reply's example plays only if no new note came after asking
  this.voice = null; this.talking = false;
  this.lesson = null; this.attempt = new Attempt(); // the course lesson in progress, and what was played for it
  this.courseDone = new Set(read('teacher-course-v1', []));
  this.convo = new Conversations();
  this.voiceChoice = read('teacher-voice-v1', DEFAULT_VOICE); // who reads replies aloud in talk mode
  this.voiceSpeed = read('teacher-voice-speed-v1', VOICE_SPEED.normal); // and how fast
  this.rhythmProfile = read('teacher-rhythm-profile-v1', null) || newProfile(); // what keeps happening to the student's timing
  this.exercise = null; this._nudgedAt = -Infinity; // the rhythm exercise being practised, and when the last nudge was
  this.enabled = read('teacher-enabled-v1', true); // switched in Settings (js/settings.js)
  window.addEventListener('pagehide', () => this.convo.save(true));
 }

 hook() {
  this._createPanel(); this._listen(); this._setupCallbacks();
  this._autoActivate(); this._loadConversation();
  this.setEnabled(this.enabled, true);
  window.addEventListener('teacher:enabled', e => this.setEnabled(e.detail));
  timing.subscribe((type, d) => { if (type === 'flag') this._nudge(d); });
  // A controller's main encoder browses the course and starts a lesson; its screen shows the chord held.
  controllers.teacher = { lessons: () => COURSE, start: id => { const l = courseLesson(id); if (l) this._startLesson(l); } };
  controllers.chord = () => (this.enabled ? this._chordName || '' : '');
  this._renderProviders(); this._renderState(); this._renderEmpty();
  // Finish an OpenRouter sign-in if we came back from one; that connects it straight away.
  completeSignIn().then(key => {
   if (!key) return;
   setKey('openrouter', key);
   this._setOpen(true);
   this._connect(providerById('openrouter'));
  }).catch(err => { this._msg('error', err.message); this._showTab('provider'); });
 }

 // Reconnects a hosted provider that was set up before (its key is in a cookie). The on-device model is
 // never loaded automatically, since that is a large download.
 _autoActivate() {
  const provider = providerById(getProviderId());
  if (!provider || provider.auth === 'local') return;
  const { engine } = engineFor(provider);
  if (engine) { this.teacher.setEngine(engine); this._active = { id: provider.id, model: getModelFor(provider.id) || provider.defaultModel }; }
 }

 _listen() {
  window.addEventListener('synth:note', ({ detail: { midi, velocity, on, source = '', time } }) => {
   if (!this.enabled) return;
   const now = time ?? performance.now();
   // Playing to a beat, a phrase ends on a rest of about a bar; otherwise on 800 ms of silence.
   this.tracker.gapMs = timing.clock.external ? Math.max(800, timing.clock.period * timing.clock.beatsPerBar * 0.9) : 800;
   // Every release counts, whatever its source: the tracker ignores notes it isn't holding.
   if (!on) { this.tracker.noteOff(midi, now); this.attempt.noteOff(midi); return; }
   if (!PLAYED.test(source)) return;
   const vel = Math.round(velocity * 127), clap = source === 'audio-clap' || source === 'midi-drum'; // a drum pad is a rhythm without a pitch, as a clap
   this._lastNoteAt = now; if (!clap) this._keysLow = followKeys(this._keysLow, midi); clearTimeout(this._missTimer);
   if (this.voice?.speaking) this.voice.cancelSpeech(); // the student's turn: stop talking
   this.tracker.noteOn(midi, vel, now); this.attempt.noteOn(midi, now);
   if (clap) this._showClap(vel); else this._showLive(midi, vel, source === 'audio' && listening.settings.mode === 'chords');
  });
  // PANIC stops the agent too: nothing more changes this turn, and the model's answer is dropped.
  window.addEventListener('synth:panic', () => { this._stopPlayback(); this.tracker.reset(); this.attempt.reset(); if (this.agent.batch.length || this._agentBusy) { this.agent.halt(); this.teacher.stop(); this._setStatus?.(null); } });
 }

 _onPhrase(a) {
  // Claps heard in Rhythm only (js/listening.js) have no pitch: their phrase is read for its rhythm alone.
  a.claps = a.noteOns.length > 0 && a.noteOns.every(n => n.note === CLAP);
  if (a.claps) { a.rhythm = this._rhythm(a); if (this.lesson) this._checkLesson(); return; }
  this._showLocal(a);
  a.rhythm = this._rhythm(a); // the [RHYTHM] summary System 2 reads with the phrase, when there is one
  if (this.lesson) { this._checkLesson(); return; } // during a lesson, the phrase is marked rather than coached
  if (!this.autoAnalyze || a.noteCount < 3) return;
  if (this.laya) { this._coachNext = a; this._coachLoop(); }
  else if (this.teacher.isConfigured) this._queue(a, { rhythm: a.rhythm });
 }

 /* ---- Tempo and rhythm (js/timing.js, js/timing-widget.js) ---- */

 // System 1 keeps the tempo: when the student rushes or drags against the beat for a few notes running, Laya
 // picks the words of a short nudge from the written ones (the first is said without Laya), shown under the
 // keys and spoken in talk mode: at most one a bar, never closer than four seconds, and only while coaching.
 async _nudge(flag) {
  if (!this.enabled || !this.autoAnalyze || (this.lesson && !isRhythm(this.lesson))) return;
  const now = performance.now();
  if (now - this._nudgedAt < Math.max(NUDGE_GAP_MS, timing.clock.period * timing.clock.beatsPerBar)) return;
  this._nudgedAt = now;
  if (flag.kind !== 'back') { this.rhythmProfile = learnTiming(this.rhythmProfile, null, flag.kind); save('teacher-rhythm-profile-v1', this.rhythmProfile); }
  const options = NUDGES[flag.kind].map(t => nudgeText(t, flag));
  let i = 0, who = 'System 1';
  if (this.laya) {
   try {
    const r = await this.laya.pick(`A student playing along with the ${timing.clock.source} at ${flag.target} BPM is now at ${flag.actual} BPM, ${flag.trend}.`, 'Which short nudge helps them most right now?', Object.fromEntries(options.map((t, k) => [String(k), t])));
    i = Number(r.choice) || 0; who = 'System 1 · Laya';
   } catch { /* the first, written for this */ }
  }
  timing.say(options[i], who);
  if (this.talking) this._say(options[i]);
 }

 // System 2 shapes the rhythm. A phrase played to a beat (the metronome, the sequencer, a MIDI clock), or for
 // an exercise or a rhythm lesson, is put on the sixteenth grid and summed up (js/timing.js): a rhythm card
 // shows the grid, what happened and one thing to do about it, and the next exercise, which System 1 picks
 // (Laya, when loaded, from the three that fit). Returns the [RHYTHM] summary for System 2, or ''.
 _rhythm(a) {
  const clock = timing.clock, from = a.noteOns[0]?.time, to = a.noteOns.at(-1)?.time;
  const practising = this.exercise || isRhythm(this.lesson);
  if (!timing.on || !clock.running || (!clock.external && !practising && !a.claps) || (this.lesson && !isRhythm(this.lesson))) return ''; // claps are for their rhythm, against your own pulse too
  const notes = timing.onsets.filter(o => o.time >= from - 5 && o.time <= to + 5);
  if (notes.filter(o => !o.chord).length < 4) return '';
  const target = this.exercise || (this.lesson?.pattern ? { pattern: this.lesson.pattern, bpm: Math.round(clock.bpm) } : null);
  const r = rhythmSummary(notes, clock, { expected: target ? target.pattern.match(/.{16}/g) : null, level: timing.level });
  if (!r) return '';
  this.rhythmProfile = learnTiming(this.rhythmProfile, r); save('teacher-rhythm-profile-v1', this.rhythmProfile);
  const { text, fix } = describeRhythm(r, timing.level), habit = issues(this.rhythmProfile, timing.level)[0]?.text || '';
  const { ids, recurring } = exerciseOptions(r, this.rhythmProfile, timing.level);
  const grades = r.events.filter(e => e.bar < r.bars.length).map(e => ({ bar: e.bar, step: e.step, grade: notes.find(o => o.time === e.time)?.grade || '' }));
  const entry = { kind: 'rhythm', who: 'System 1', bars: r.bars, grades, text, fix, habit, next: exercise(ids[0], r, recurring) };
  entry.msg = rhythmMessage(r, { described: `${text} ${fix} Next exercise: ${entry.next.label}.`, profile: this.rhythmProfile, lesson: isRhythm(this.lesson) ? `${this.lesson.title}: ${this.lesson.task}` : '', target, level: timing.level });
  const node = this._add(entry);
  if (!(this.autoAnalyze && (this.laya || this.teacher.isConfigured))) this._say(fix); // else the coaching that follows speaks
  // Laya chooses the next exercise among the three that fit, and the card is redrawn with its choice.
  if (this.laya) this.laya.pick(`A student just played: ${text} ${habit ? `Recurring: ${habit}.` : ''}`, 'Which exercise should they practise next?', Object.fromEntries(ids.map(id => [id, EXERCISES[id].says])))
   .then(c => { if (!ids.includes(c.choice)) return; entry.next = exercise(c.choice, r, recurring); entry.who = `System 1 · Laya, ${c.ms} ms`; const fresh = this._render(entry); node.replaceWith(fresh); this.convo.save(); }).catch(() => {});
  return entry.msg;
 }

 // An exercise: its tempo is set and the metronome switched on, the pattern plays once from the next bar (a low
 // C on the downbeat), and the phrases that follow are marked against it until another is chosen, it is ended,
 // or the conversation is new.
 _setExercise(ex) {
  this.exercise = ex;
  const bar = this.panel.querySelector('.tp-exercise-bar');
  bar.hidden = !ex;
  if (!ex) return;
  bar.querySelector('span').textContent = `Exercise: ${ex.label} · ${ex.pattern.match(/.{16}/g).join(' | ')}`;
  if (window.synth) window.synth.tempo = ex.bpm;
  const m = document.getElementById('metronomeToggle');
  if (m && !m.checked) m.click();
  if (!timing.on) document.getElementById('timingToggle')?.click();
  this._playExercise(ex);
 }
 _playExercise(ex) {
  const c = timing.clock, now = performance.now();
  const wait = c.external ? Math.max(0, c.timeOf(Math.ceil(c.beatAt(now) / c.beatsPerBar + 0.05) * c.beatsPerBar) - now) : 0;
  this._stopPlayback();
  this._later(wait, () => this._playSteps(patternSteps(ex.pattern, ex.accent), ex.bpm * 4, ex.label));
 }

 // Laya decides one phrase at a time (a model session can't run twice at once); if more phrases end while
 // it is busy, only the latest is coached next.
 async _coachLoop() {
  if (this._coaching) return;
  this._coaching = true;
  while (this._coachNext) { const a = this._coachNext; this._coachNext = null; await this._coach(a); }
  this._coaching = false;
 }

 // System 1: Laya picks the next step at once, and the coaching menu supplies its words and notes, so they
 // are always right. In Slow mode the System 2 model then thinks the phrase through, building on that step.
 async _coach(a) {
  this._setStatus('coaching');
  let d;
  try { d = await this.laya.decide(a, this._coachHistory); }
  catch (err) { this._setStatus(null); this._msg('error', `Laya couldn't decide: ${err.message}`); return; }
  this._coachHistory.push(d.move);
  const move = buildMove(d.move, a), slow = this.mode === 'slow' && this.teacher.isConfigured;
  this._setStatus(null);
  this._add({ kind: 'coach', who: `System 1 · Laya, ${d.ms} ms`, text: `${describePlayed(a)} ${move.say}`, example: move.example,
   why: slow ? null : { a: compact(a), coach: `${describePlayed(a)} Next step: ${move.say}`, suggested: d.explain >= 0.5 } });
  const at = performance.now();
  this._say(`${describePlayed(a)} ${move.say}`).then(() => { if (this._lastNoteAt <= at) this._playSteps(move.example.steps, move.example.bpm); });
  if (slow) this._queue(a, { think: true, coach: `${describePlayed(a)} Next step: ${move.say}`, rhythm: a.rhythm });
 }

 // While the model answers one phrase, only the most recent of the phrases played meanwhile is sent next.
 _queue(a, opts) { this._phraseQueue.push({ a, opts }); this._processQueue(); }
 async _processQueue() {
  if (this._processing || !this._phraseQueue.length) return;
  this._processing = true;
  const { a, opts } = this._phraseQueue[this._phraseQueue.length - 1];
  this._phraseQueue = [];
  this._askedAt = performance.now();
  await this.teacher.analyzePhrase(a, opts);
  this._processing = false;
  if (this._phraseQueue.length) this._processQueue();
 }

 _setupCallbacks() {
  this.teacher.onResponse = (text, play, info = {}) => {
   this._msg('teacher', text, play, info);
   if (info.actions) this._act(info.actions);
   // Play the example (after reading the reply aloud in talk mode), unless the student has started playing
   // again since asking.
   const asked = this._askedAt, quiet = this._quietNext; this._quietNext = false;
   this._say(text).then(() => { if (play && !quiet && this._lastNoteAt <= asked) this._playSteps(play.steps, play.bpm, play.label); });
  };
  this.teacher.onError = m => this._msg('error', m);
  this.teacher.onStatus = s => this._setStatus(s === 'ready' ? null : s);
 }

 // Plays a suggestion through the synth (and any plug-in instrument following it), moved onto the student's
 // 25 keys. Each step is one beat; a step with several notes is struck together as a chord.
 _playSteps(steps, bpm, label = 'the example') {
  this._lastExample = { steps, bpm, label }; // what "again", "longer" or "faster" refer to
  const synth = window.synth;
  if (!synth) return;
  this._stopPlayback(); synth.ensureAudio();
  steps = fitToKeys(steps, this._keysLow);
  const beat = 60000 / bpm;
  const key = n => document.querySelector(`#keyboard [data-midi="${n}"]`);
  steps.forEach((chord, i) => {
   this._later(i * beat, () => chord.forEach(n => { synth.noteOn(toNote(n)); this._sounding.add(n); key(n)?.classList.add('teacher-hint'); }));
   this._later(i * beat + beat * 0.8, () => chord.forEach(n => { synth.noteOff(toNote(n)); this._sounding.delete(n); key(n)?.classList.remove('teacher-hint'); }));
  });
 }
 _later(ms, fn) { this._timers.push(setTimeout(fn, ms)); }
 _stopPlayback() {
  this._timers.forEach(clearTimeout); this._timers = [];
  this._sounding.forEach(n => window.synth?.noteOff(toNote(n))); this._sounding.clear();
  document.querySelectorAll('#keyboard .teacher-hint').forEach(k => k.classList.remove('teacher-hint'));
 }

 /* ---- Panel ---- */

 _createPanel() {
  document.head.append(Object.assign(document.createElement('style'), { textContent: STYLE }));
  const p = document.createElement('aside'); p.id = 'teacher-panel';
  p.setAttribute('aria-label', 'AI music theory teacher');
  p.innerHTML = `
   <div class="tp-resize" role="separator" aria-orientation="vertical" aria-label="Teacher panel width: drag, or use the arrow keys" tabindex="0" title="Drag to resize the panel. Double-click to reset."></div>
   <header class="tp-head">
    <div class="tp-title-row"><h2>AI Teacher</h2><span class="tp-status">Not connected</span></div>
    <button type="button" class="tp-summary" title="Change provider"><span class="tp-summary-text"></span><span class="tp-change">Change</span></button>
   </header>
   <nav class="tp-tabs" role="tablist">
    <button type="button" role="tab" id="tp-tab-lesson" aria-controls="tp-view-lesson" data-tab="lesson">Lesson</button>
    <button type="button" role="tab" id="tp-tab-course" aria-controls="tp-view-course" data-tab="course">Course</button>
    <button type="button" role="tab" id="tp-tab-provider" aria-controls="tp-view-provider" data-tab="provider">Provider</button>
   </nav>
   <section class="tp-view" id="tp-view-lesson" role="tabpanel" aria-labelledby="tp-tab-lesson">
    <div class="tp-live" aria-live="off"><span class="tp-live-note">♪</span><span class="tp-live-detail">Play something…</span><span class="tp-chip" hidden></span></div>
    <div class="tp-exercise-bar" hidden><span></span><button type="button" class="tp-exercise-hear">▶ Hear it</button><button type="button" class="tp-exercise-end">End exercise</button></div>
    <div class="tp-lesson-bar" hidden><span></span><button type="button" class="tp-lesson-hear">▶ Example</button><button type="button" class="tp-lesson-end">End lesson</button></div>
    <div class="tp-messages" role="log" aria-live="polite"></div>
    <div class="tp-foot">
     <div class="tp-mode" hidden><span class="tp-seg" role="radiogroup" aria-label="Teaching speed"><button type="button" role="radio" data-mode="fast">Fast</button><button type="button" role="radio" data-mode="slow">Slow</button></span><span class="tp-mode-note"></span></div>
     <div class="tp-foot-row"><label><input type="checkbox" class="auto-check"/>Coach each phrase I play</label><label title="On: the teacher changes the workspace itself when you ask (each change listed with Undo; clearing or saving asks first). Off: it suggests, and you apply."><input type="checkbox" class="agent-check"/>Agent can act</label><span class="tp-row"><select class="tp-history" aria-label="Conversation history"></select><button type="button" class="clear-btn" title="Start a new conversation; this one stays in the history">New</button></span></div>
     <form class="tp-ask"><input type="text" class="question-input" placeholder="Ask about theory…" aria-label="Ask the teacher"/><button type="button" class="tp-talk" aria-pressed="false" title="Voice mode: speak to the teacher and hear it answer, and sing or play to it">🎙 Talk</button><button type="button" class="tp-ptt" hidden title="While held, what you say is a question and nothing is taken as a note">Hold to talk</button><button type="submit" class="tp-primary tp-ask-btn">Ask</button></form>
     <p class="tp-talk-note" role="status" hidden></p>
    </div>
   </section>
   <section class="tp-view tp-course-view" id="tp-view-course" role="tabpanel" aria-labelledby="tp-tab-course" hidden>
    <p class="tp-intro">Short lessons, first on using this workspace, then on tempo and rhythm (and how the teacher's two systems keep time), then music theory from Open Music Theory played on your keys. Each one explains an idea and gives you something to do or play: the teacher watches and tells you when you have it. Switch on 🎓 buttons in ☰ Settings and every widget gets one that opens its guide.</p>
    <div class="tp-course"></div>
    <p class="tp-credit">Music theory lessons adapted from <a href="${OMT.url}" target="_blank" rel="noopener">Open Music Theory</a> by Kris Shaffer, Bryn Hughes, Brian Moseley and contributors, licensed <a href="${OMT.licenseUrl}" target="_blank" rel="noopener">${OMT.license}</a>.</p>
   </section>
   <section class="tp-view tp-provider-view" id="tp-view-provider" role="tabpanel" aria-labelledby="tp-tab-provider" hidden>
    <p class="tp-intro">The teacher works in two layers. System 1 is always Laya, on this device: it answers at once, coaching each phrase, keeping time, teaching the widgets and changing settings. System 2 thinks and explains in its own words: choose it below, on this device or from a provider you sign in to. Each provider is a separate, direct connection with its own sign-in.</p>
    <h3 class="tp-layer-title">System 1 · fast · always Laya</h3>
    <div class="tp-system-one"></div>
    <h3 class="tp-layer-title">System 2 · thinking · your choice</h3>
    <div class="tp-providers" role="radiogroup" aria-label="System 2"></div>
    <div class="tp-voices"></div>
    <div class="tp-storage"></div>
   </section>`;
  document.body.append(p); this.panel = p;

  const toggle = document.createElement('button'); toggle.className = 'teacher-toggle';
  this._toggle = toggle;
  toggle.onclick = () => this._setOpen(p.classList.contains('collapsed'));
  document.body.append(toggle);
  this._setOpen(read('teacher-open-v1', innerWidth >= 900), false);

  p.querySelectorAll('.tp-tabs button').forEach(b => { b.onclick = () => this._showTab(b.dataset.tab); });
  p.querySelector('.tp-summary').onclick = () => this._showTab('provider');
  const auto = p.querySelector('.auto-check');
  auto.checked = this.autoAnalyze;
  auto.onchange = () => { this.autoAnalyze = auto.checked; save('teacher-auto-v1', this.autoAnalyze); };
  const acts = p.querySelector('.agent-check');
  acts.checked = this.agentActs;
  acts.onchange = () => { this.agentActs = acts.checked; save('teacher-agent-acts-v1', this.agentActs); };
  p.querySelector('.clear-btn').onclick = () => { this.convo.startNew(); this._loadConversation(); };
  p.querySelector('.tp-history').onchange = e => { if (e.target.value && this.convo.open(e.target.value)) this._loadConversation(); };
  p.querySelectorAll('.tp-seg button').forEach(b => { b.onclick = () => { this.mode = b.dataset.mode; save('teacher-mode-v1', this.mode); this._renderMode(); }; });
  p.querySelector('.tp-ask').onsubmit = e => { e.preventDefault(); this._ask(); };
  p.querySelector('.tp-talk').onclick = () => this._toggleTalk();
  // Listening › Speech is for talking to the teacher: its voice mode comes on.
  // Only as Speech is chosen, or listening starts in it: switching Talk off afterwards stays off.
  let was = { mode: listening.settings.mode, active: listening.active };
  listening.subscribe((type, st) => {
   if (type !== 'state') return;
   const turned = st.mode === 'speech' && st.active && (was.mode !== 'speech' || !was.active);
   was = { mode: st.mode, active: st.active };
   if (turned && !this.talking && this.enabled) this._toggleTalk();
  });
  const ptt = p.querySelector('.tp-ptt'), hold = on => { if (!listening.voice) return; listening.voice.ptt = on; if (on) { listening.voice.sm.lastSpeech = performance.now(); this._pttUntil = Infinity; } else this._pttUntil = performance.now() + 2500; ptt.classList.toggle('held', on); };
  ptt.onpointerdown = e => { e.preventDefault(); hold(true); };
  ptt.onpointerup = ptt.onpointercancel = ptt.onpointerleave = () => { if (listening.voice?.ptt) hold(false); };
  this._panelResize(p.querySelector('.tp-resize'));
  p.querySelector('.tp-lesson-end').onclick = () => this._endLesson();
  p.querySelector('.tp-exercise-end').onclick = () => this._setExercise(null);
  p.querySelector('.tp-exercise-hear').onclick = () => this.exercise && this._playExercise(this.exercise);
  p.querySelector('.tp-lesson-hear').onclick = () => { const l = this.lesson; if (!l) return; if (l.example) this._playSteps(l.example.steps, l.example.bpm); else this._showTargets(l.show); };
  this._renderCourse();
  this._teachButtons();
  if (!canListen() && !canSpeak()) { const t = p.querySelector('.tp-talk'); t.disabled = true; t.title = 'This browser can\'t listen or speak.'; }
  this._showTab('lesson');
 }

 // The panel's width, dragged from its left edge (300–720 px, never more than the window leaves), and kept.
 _panelResize(edge) {
  const setWidth = (w, keep = true) => {
   if (!w) { document.documentElement.style.removeProperty('--teacher-width'); if (keep) save('teacher-width-v1', 0); }
   else {
    const width = Math.round(Math.max(300, Math.min(720, innerWidth - 240, w)));
    document.documentElement.style.setProperty('--teacher-width', `${width}px`);
    if (keep) save('teacher-width-v1', width);
   }
   window.dispatchEvent(new Event('resize'));
  };
  const saved = read('teacher-width-v1', 0);
  if (saved) setWidth(saved, false);
  const move = e => setWidth(innerWidth - e.clientX);
  const up = () => { edge.classList.remove('dragging'); removeEventListener('pointermove', move); removeEventListener('pointerup', up); removeEventListener('pointercancel', up); };
  edge.onpointerdown = e => { if (e.button !== 0) return; e.preventDefault(); edge.classList.add('dragging'); addEventListener('pointermove', move); addEventListener('pointerup', up); addEventListener('pointercancel', up); };
  edge.ondblclick = () => setWidth(0);
  edge.onkeydown = e => { const d = { ArrowLeft: 20, ArrowRight: -20 }[e.key]; if (!d) return; e.preventDefault(); setWidth(this.panel.getBoundingClientRect().width + d * (e.shiftKey ? 4 : 1)); };
 }

 _showTab(tab) {
  this.panel.querySelectorAll('.tp-tabs button').forEach(b => b.setAttribute('aria-selected', b.dataset.tab === tab));
  this.panel.querySelectorAll('.tp-view').forEach(v => { v.hidden = v.id !== `tp-view-${tab}`; });
  if (tab === 'provider') { this._renderVoices(); this._renderStorage(); }
  if (tab === 'course') this._renderCourse(); // with what has been noticed about the student's timing since
 }

 // Switched off in Settings, the panel, its pull tab and every 🎓 button are hidden (html.teacher-off), its tab
 // closes, and it stops listening, talking, coaching and playing; its conversation and lessons are kept.
 // Switched on, it opens as it was left. Laya, once chosen and downloaded, loads by itself whenever the teacher
 // is on: quick from the cache, it is what coaches and teaches the widgets. (Qwen never loads by itself: it
 // needs gigabytes of GPU memory.)
 setEnabled(on, starting = false) {
  this.enabled = on;
  document.documentElement.classList.toggle('teacher-off', !on);
  if (on) {
   if (!starting) this._setOpen(read('teacher-open-v1', innerWidth >= 900), false);
   if (!this.laya && read('teacher-laya-auto-v1', false)) modelCacheInfo().then(i => { if (i.laya && this.enabled && !this.laya) this._loadLaya(); }).catch(() => {});
   return;
  }
  this._setOpen(false, false);
  if (this.talking) this.voice.stop();
  this.voice?.cancelSpeech();
  this._stopPlayback(); this._phraseQueue = []; this._coachNext = null;
  this.tracker.reset(); this.attempt.reset(); clearTimeout(this._missTimer);
  this._resetTeacher(); // interrupts a reply in progress; the model keeps its memory of the conversation
  this._setStatus(null);
 }

 _setOpen(open, persist = true) {
  const p = this.panel, toggle = this._toggle;
  p.classList.toggle('collapsed', !open);
  document.documentElement.classList.toggle('teacher-open', open);
  toggle.textContent = open ? '▶' : '◀';
  toggle.title = open ? 'Hide the AI teacher' : 'Show the AI teacher';
  toggle.setAttribute('aria-label', toggle.title); toggle.setAttribute('aria-expanded', open);
  if (persist) save('teacher-open-v1', open);
  window.dispatchEvent(new Event('resize'));
 }

 // The status chip, the header summary and the ask box all follow the connection.
 _setStatus(transient) {
  const chip = this.panel.querySelector('.tp-status');
  const [cls, text] = transient === 'thinking' ? ['thinking', 'Answering…']
   : transient === 'reasoning' ? ['thinking', 'Thinking it through…']
   : transient === 'coaching' ? ['thinking', 'Coaching…']
   : transient === 'loading' ? ['loading', 'Loading model…']
   : this.teacher.isConfigured ? ['ready', 'Ready'] : this.laya ? ['ready', 'Fast only'] : ['', 'Not connected'];
  chip.className = `tp-status ${cls}`; chip.textContent = text;
 }
 _renderState() {
  this._setStatus(null);
  // Always open: requests to play something are met with no model at all (js/requests.js).
  const summary = this.panel.querySelector('.tp-summary-text');
  summary.replaceChildren();
  // Both layers: "Laya + Groq · llama-3.3-70b", "Laya + Qwen 3.5 4B", "Laya · alone", or System 2 alone.
  const system2 = this.teacher.isConfigured && this._active ? (this._active.id === 'local'
   ? [LOCAL_MODELS.find(m => m.id === this._active.model)?.label.split(' —')[0] || 'Qwen', '']
   : [providerById(this._active.id).name, ` · ${this._active.model.replace(/^[^/]+\//, '')}`]) : null;
  if (this.laya) summary.append(el('b', { textContent: 'Laya' }), system2 ? ' + ' : ' · alone');
  if (system2) summary.append(el('b', { textContent: system2[0] }), system2[1]);
  if (!this.laya && !system2) summary.textContent = 'Not connected — choose a provider';
  this.panel.querySelector('.tp-change').textContent = system2 || this.laya ? 'Change' : 'Choose';
  this.panel.querySelector('.question-input').placeholder = this.teacher.isConfigured ? 'Ask about theory or the app…' : this.laya ? 'Ask about a widget, plug-in or lesson…' : 'Ask me to play something…';
  this._renderMode();
 }
 // The Fast/Slow switch appears once Laya (System 1) is loaded; Slow needs a System 2 model as well.
 _renderMode() {
  const box = this.panel.querySelector('.tp-mode');
  box.hidden = !this.laya;
  const slowOk = this.teacher.isConfigured, mode = slowOk ? this.mode : 'fast';
  box.querySelectorAll('button').forEach(b => { b.setAttribute('aria-checked', b.dataset.mode === mode); b.disabled = b.dataset.mode === 'slow' && !slowOk; });
  const system2 = this._active?.id === 'local' ? 'Qwen' : providerById(this._active?.id)?.name || 'the model';
  box.querySelector('.tp-mode-note').textContent = mode === 'slow' ? `Laya coaches at once, then ${system2} ${system2 === 'Qwen' ? 'thinks it through' : 'explains it'}.` : `Laya coaches each phrase at once.${slowOk ? ' Tap "Explain why" for more.' : ''}`;
 }
 // The live strip ("♪ Play something…", then the note just played and the chord held) is for before the
 // conversation starts; once there is anything in it, the strip makes way.
 _renderLive() { this.panel.querySelector('.tp-live').hidden = !!this.panel.querySelector('.tp-messages .teacher-msg'); }
 _renderEmpty() {
  this._renderLive();
  const box = this.panel.querySelector('.tp-messages');
  box.querySelector('.tp-empty')?.remove();
  if (box.querySelector('.teacher-msg')) return;
  const empty = el('div', { className: 'tp-empty' });
  if (this.laya) empty.append(`Play a phrase and pause for a moment: Laya names it and gives you the next step with an example to hear. Ask about any widget or plug-in and Laya shows you how it works.${this.teacher.isConfigured ? ' Switch to Slow, or ask a question below, for a fuller explanation.' : ''}`);
  else if (this.teacher.isConfigured) empty.append('Play a phrase and pause for a moment: the teacher names it, explains it and plays a suggestion. Or ask a question below.');
  else {
   const go = el('button', { type: 'button', className: 'tp-primary', textContent: 'Choose a provider' });
   go.onclick = () => this._showTab('provider');
   empty.append('Note names, chords and scales show here as you play, with no setup. Connect a provider to have the teacher explain them and suggest what to try next.', go);
  }
  box.append(empty);
 }

 /* ---- Provider tab ---- */

 _renderProviders() {
  this.panel.querySelector('.tp-system-one').replaceChildren(this._layaCard());
  const list = this.panel.querySelector('.tp-providers');
  list.replaceChildren(this._card({ id: NO_SYSTEM_TWO, name: 'None: Laya alone', how: 'Nothing to sign in to', where: 'Nothing you play or ask leaves this browser', cost: 'Free' }));
  for (const group of GROUPS) {
   const members = PROVIDERS.filter(pr => pr.auth === group.auth);
   if (!members.length) continue;
   list.append(el('h3', { className: 'tp-group-title', textContent: group.title }));
   members.forEach(pr => list.append(this._card(pr)));
  }
 }

 _card(provider) {
  const id = provider.id, selected = this._selected === id, active = id === NO_SYSTEM_TWO ? !this.teacher.isConfigured : this._active?.id === id && this.teacher.isConfigured;
  const radio = el('input', { type: 'radio', name: 'tp-provider', value: id, checked: selected });
  const name = el('span', { className: 'tp-card-name' }, provider.name,
   el('span', { className: `tp-badge${/^Free/.test(provider.cost) ? ' free' : ''}`, textContent: provider.cost }));
  if (active) name.append(el('span', { className: 'tp-badge on', textContent: id === NO_SYSTEM_TWO ? 'In use' : 'Connected' }));
  else if (getKey(id)) name.append(el('span', { className: 'tp-badge saved', textContent: provider.auth === 'openrouter' ? 'Signed in' : 'Key saved' }));
  const head = el('label', { className: 'tp-card-head' }, radio,
   el('span', { className: 'tp-card-text' }, name, el('span', { className: 'tp-card-meta', textContent: `${provider.how} · ${provider.where}` })));
  const body = el('div', { className: 'tp-card-body', hidden: !selected });
  const card = el('div', { className: `tp-card${selected ? ' selected' : ''}` }, head, body);
  card.dataset.id = id;
  radio.onchange = () => {
   this._selected = id; this._renderProviders();
   this.panel.querySelector(`.tp-card[data-id="${id}"] input[type=radio]`)?.focus(); // keep arrow-key navigation
  };
  if (selected) this._fillBody(provider, body);
  return card;
 }

 _fillBody(provider, body) {
  const status = el('p', { className: 'tp-card-status', role: 'status' });
  if (provider.id === NO_SYSTEM_TWO) return this._fillNone(body);
  if (provider.auth === 'local') return this._fillLocal(body, status);
  const id = provider.id, active = this._active?.id === id;
  const field = (text, node) => el('label', { className: 'tp-field' }, text, node);
  const connect = el('button', { type: 'button', className: 'tp-primary', textContent: active ? 'Reconnect' : 'Connect' });

  // Model: a dropdown filled from the provider's live list (or its suggestions until we have one); a custom
  // endpoint gets a free-text field, since there is no list to rely on.
  let model;
  if (provider.auth === 'custom') {
   model = el('input', { type: 'text', value: getModelFor(id) || '', placeholder: 'model name' });
  } else {
   model = el('select');
   this._fillModels(provider, model, provider.models?.length ? provider.models : [getModelFor(id) || provider.defaultModel]);
   if (id === 'openrouter') (this._openRouterModels ||= fetchOpenRouterModels()).then(({ free, premium }) => this._fillModelGroups(model, getModelFor(id) || provider.defaultModel, [['Free', free], ['Premium · needs credit', premium]])).catch(() => { this._openRouterModels = null; });
   model.onchange = () => { if (this._active?.id === id) { setModelFor(id, model.value); this._activate(provider, model.value, true); status.textContent = `Now using ${model.value}.`; status.className = 'tp-card-status ok'; } };
  }

  const keyInput = el('input', { type: 'password', autocomplete: 'off', spellcheck: false, placeholder: getKey(id) ? 'Key saved — paste a new one to replace it' : provider.keyHint });
  const forget = el('button', { type: 'button', className: 'tp-link', textContent: provider.auth === 'openrouter' ? 'Sign out' : 'Forget key' });
  forget.onclick = () => this._forget(provider);
  const keyLink = provider.keyUrl ? el('p', { className: 'tp-note' }, 'Get a key: ', el('a', { href: provider.keyUrl, target: '_blank', rel: 'noopener', textContent: host(provider.keyUrl) })) : null;

  if (provider.auth === 'openrouter') {
   if (getKey(id)) body.append(el('div', { className: 'tp-row' }, el('span', { className: 'tp-note', textContent: 'Signed in to OpenRouter.' }), forget));
   else {
    const signin = el('button', { type: 'button', className: 'tp-primary', textContent: 'Sign in with OpenRouter' });
    signin.onclick = () => signIn().catch(err => { status.textContent = err.message; status.className = 'tp-card-status bad'; });
    body.append(el('div', { className: 'tp-row' }, signin),
     el('p', { className: 'tp-note', textContent: 'No key to copy: approve on openrouter.ai and you come back connected. A free account can use the free models.' }),
     el('details', {}, el('summary', { textContent: 'Or paste an OpenRouter key' }), keyInput));
   }
   body.append(field('Model', model));
  } else if (provider.auth === 'custom') {
   const base = el('input', { type: 'text', value: getBase(id) || '', placeholder: 'https://api.example.com/v1' });
   body.append(field('API base URL', base), field('API key', keyInput), field('Model', model),
    el('p', { className: 'tp-note', textContent: 'Any service with an OpenAI-style /chat/completions endpoint that allows browser requests (CORS).' }));
   connect.onclick = () => this._connect(provider, { key: keyInput.value.trim(), base: base.value.trim(), model: model.value.trim() }, { connect, status, keyInput, model });
  } else {
   body.append(field('API key', keyInput));
   if (getKey(id)) body.append(el('div', { className: 'tp-row' }, forget));
   if (keyLink) body.append(keyLink);
   body.append(field('Model', model));
  }
  if (provider.auth !== 'custom') connect.onclick = () => this._connect(provider, { key: keyInput.value.trim(), model: model.value }, { connect, status, keyInput, model });
  body.append(el('div', { className: 'tp-row' }, connect), status);
 }

 _fillModels(provider, select, ids, chosen = getModelFor(provider.id) || provider.defaultModel) {
  select.replaceChildren(...ids.map(m => el('option', { value: m, textContent: m })));
  if (chosen && !ids.includes(chosen)) select.prepend(el('option', { value: chosen, textContent: chosen }));
  select.value = chosen || ids[0] || '';
 }
 _fillModelGroups(select, chosen, groups) {
  select.replaceChildren();
  for (const [title, list] of groups) {
   if (!list.length) continue;
   const g = el('optgroup'); g.label = title;
   list.forEach(m => g.append(el('option', { value: m.id, textContent: m.label })));
   select.append(g);
  }
  select.value = chosen;
  if (select.value !== chosen && select.options.length) select.selectedIndex = 0;
 }

 // System 1, always Laya: its own card above the System 2 choices, open, with its state.
 _layaCard() {
  const name = el('span', { className: 'tp-card-name' }, SYSTEM_ONE.name, el('span', { className: 'tp-badge free', textContent: SYSTEM_ONE.cost }),
   el('span', { className: `tp-badge${this.laya ? ' on' : ''}`, textContent: this.laya ? 'Loaded' : 'Not loaded' }));
  const body = el('div', { className: 'tp-card-body' }), card = el('div', { className: 'tp-card selected tp-laya' },
   el('div', { className: 'tp-card-head' }, el('span', { className: 'tp-card-text' }, name, el('span', { className: 'tp-card-meta', textContent: `${SYSTEM_ONE.how} · ${SYSTEM_ONE.where}` }))), body);
  this._fillLaya(body, el('p', { className: 'tp-card-status', role: 'status' }));
  return card;
 }
 // No System 2: Laya alone. Choosing it disconnects the one in use (keys are kept, Qwen is unloaded).
 _fillNone(body) {
  body.append(el('p', { className: 'tp-note', textContent: 'Laya coaches, keeps time, answers questions about the app from its guides and changes settings; the composer plays what you ask for. Nothing explains in its own words.' }));
  if (this.teacher.isConfigured) body.append(el('div', { className: 'tp-row' }, el('button', { type: 'button', className: 'tp-primary', textContent: 'Use Laya alone', onclick: () => this._systemOneOnly() })));
 }
 _systemOneOnly() {
  if (this._localEngine) { this._localEngine.unload?.(); this._localEngine = null; }
  this._resetTeacher(); this.teacher.setEngine(null); this._active = null;
  setProviderId(NO_SYSTEM_TWO); this._selected = NO_SYSTEM_TWO;
  this._renderProviders(); this._renderState(); this._renderEmpty();
  this._msg('info', this.laya ? 'Laya alone now (System 1): nothing you play or ask leaves this browser.' : 'No System 2 now. Load Laya in the Provider tab for coaching and answers about the app.');
 }

 // System 1 on its own: Laya coaches each phrase and teaches the widgets and plug-ins, choosing from written
 // guides (js/system-one.js), so it needs no WebGPU and runs on the CPU too.
 _fillLaya(body, status) {
  const btn = el('button', { type: 'button', className: 'tp-primary', textContent: this.laya ? 'Loaded' : `Download and load Laya (${LAYA_MB} MB)`, disabled: !!this.laya });
  const bar = el('progress', { max: 1, hidden: true });
  btn.onclick = () => this._loadLaya({ btn, bar, status });
  body.append(
   el('p', { className: 'tp-note', textContent: 'Laya is a fast decision model. It never writes text: it chooses. The moment you finish a phrase it picks your next step from the coaching menu; ask about a widget or plug-in (or press its 🎓, when 🎓 buttons are on in Settings) and it picks the guide step that answers you and lights up the control; on a plug-in, "Next tip" has it choose which control to try next. Everything it says was written in advance, so it is never wrong about the app. Whichever System 2 you choose, Laya stays System 1.' }),
   el('div', { className: 'tp-row' }, btn), bar, status,
   el('p', { className: 'tp-note', textContent: `Runs on the GPU where it can, otherwise the CPU. The first load downloads ${LAYA_MB} MB; after that it loads from the browser cache by itself.` }));
 }

 async _loadLaya(ui = null) {
  if (this.laya || this._layaLoading) return;
  this._layaLoading = true;
  if (ui) { ui.btn.disabled = true; ui.btn.textContent = 'Loading…'; ui.bar.hidden = false; ui.bar.removeAttribute('value'); }
  this._setStatus('loading');
  const show = prog => { if (!ui) return; ui.status.className = 'tp-card-status'; ui.status.textContent = prog.text || 'Loading…'; if (typeof prog.progress === 'number') ui.bar.value = prog.progress; };
  try {
   this.laya = await LayaCoach.load(show);
   save('teacher-laya-auto-v1', true);
   this._renderProviders(); this._renderState(); this._renderEmpty();
   if (ui) {
    this._msg('info', `Laya is ready (System 1). Play a phrase and pause for your next step; ask about any widget or plug-in and Laya shows you the control.`);
    this._showTab('lesson');
   }
  } catch (err) {
   if (ui) { ui.status.textContent = err.message; ui.status.className = 'tp-card-status bad'; ui.btn.disabled = false; ui.btn.textContent = 'Try again'; }
  } finally {
   this._layaLoading = false; this._setStatus(null);
   if (ui) ui.bar.hidden = true;
  }
 }

 _fillLocal(body, status) {
  const select = el('select');
  LOCAL_MODELS.forEach(m => select.append(el('option', { value: m.id, textContent: m.label })));
  select.value = getModelFor('local') || LOCAL_DEFAULT;
  const gpu = webgpuAvailable(), loaded = this._active?.id === 'local';
  const btn = el('button', { type: 'button', className: 'tp-primary', textContent: loaded ? 'Reload' : !gpu ? 'Needs WebGPU' : this.laya ? 'Download and load Qwen' : 'Download and load Qwen (and Laya)', disabled: !gpu });
  const bar = el('progress', { max: 1, hidden: true });
  select.disabled = !gpu;
  btn.onclick = () => this._loadLocal(select.value, { btn, bar, status, select });
  body.append(
   el('p', { className: 'tp-note', textContent: `Qwen (System 2) thinks through explanations and answers your questions in this browser, while Laya (System 1, ${LAYA_MB} MB) picks your next step the moment you finish a phrase; Laya is loaded with it if it isn't yet. No account, key or cookie, and nothing you play leaves the browser.` }),
   el('label', { className: 'tp-field' }, 'Qwen size', select), el('div', { className: 'tp-row' }, btn), bar, status,
   el('p', { className: 'tp-note', textContent: gpu
    ? 'The first load downloads the model; later visits load it from the browser cache.'
    : 'This browser has no WebGPU, so Qwen can\'t run here: choose a provider below for System 2. Laya (System 1) still runs, on the CPU. Use desktop Chrome or Edge for Qwen.' }));
 }

 // Loads Laya (System 1) and, where WebGPU allows, Qwen (System 2). A Qwen already loaded at another size is
 // unloaded first to free GPU memory. If Laya fails to load, Qwen still runs on its own.
 async _loadLocal(modelId, { btn, bar, status, select }) {
  if (this._loading) return;
  this._loading = true;
  btn.disabled = select.disabled = true; btn.textContent = 'Loading…'; bar.hidden = false; bar.removeAttribute('value');
  status.className = 'tp-card-status'; status.textContent = 'Starting…';
  this._setStatus('loading');
  const show = prog => { status.textContent = prog.text || 'Loading…'; if (typeof prog.progress === 'number') bar.value = prog.progress; else bar.removeAttribute('value'); };
  let warning = '';
  try {
   if (!this.laya) {
    try { this.laya = await LayaCoach.load(show); save('teacher-laya-auto-v1', true); }
    catch (err) { if (!webgpuAvailable()) throw err; warning = `Laya couldn't load (${err.message}), so fast coaching is off; Qwen works on its own.`; }
   }
   let engine = null;
   if (webgpuAvailable()) {
    if (this._localEngine) { this.teacher.setEngine(null); await this._localEngine.unload?.(); this._localEngine = null; }
    engine = await LocalEngine.load(modelId, prog => show({ ...prog, text: `Qwen: ${prog.text || 'loading…'}` }));
   }
   this._localEngine = engine;
   this._resetTeacher(); this.teacher.setEngine(engine);
   this._active = { id: 'local', model: modelId };
   setProviderId('local'); setModelFor('local', modelId);
   this._connected(providerById('local'));
   if (warning) this._msg('error', warning);
  } catch (err) {
   status.textContent = err.message; status.className = 'tp-card-status bad';
   btn.textContent = this._active?.id === 'local' ? 'Reload' : 'Try again';
   this._setStatus(null);
  } finally {
   this._loading = false; btn.disabled = false; select.disabled = !webgpuAvailable(); bar.hidden = true;
  }
 }

 // Saves what was entered, checks the key by listing the provider's models (free; nothing is generated),
 // picks a model, and connects. `ui` holds the card's controls when called from the Provider tab.
 async _connect(provider, { key = '', base = '', model = '' } = {}, ui = null) {
  const id = provider.id;
  const say = (text, ok) => { if (ui) { ui.status.textContent = text; ui.status.className = `tp-card-status${ok === true ? ' ok' : ok === false ? ' bad' : ''}`; } else if (ok === false) this._msg('error', text); };
  if (provider.auth === 'custom' && base) setBase(id, base);
  if (provider.auth === 'custom' && !getBase(id)) return say('Enter the API base URL.', false);
  const apiKey = key || getKey(id); // a newly typed key is only saved once it checks out
  if (!apiKey) return say(provider.auth === 'openrouter' ? 'Sign in or paste a key first.' : 'Paste an API key first.', false);
  if (ui) ui.connect.disabled = true;
  say('Checking the key…');
  let ids = null;
  try { ids = await listModels(provider, apiKey); }
  catch (err) {
   const rejected = err.status === 401 || err.status === 403;
   // A custom endpoint may simply have no /models list; anything else that fails is worth stopping on.
   if (rejected || provider.auth !== 'custom') { if (ui) ui.connect.disabled = false; return say(err.message, false); }
  }
  let chosen = model || getModelFor(id);
  if (ids?.length) {
   chosen = provider.auth === 'custom' ? (model || pickModel(provider, ids, getModelFor(id))) : pickModel(provider, ids, model || getModelFor(id));
   if (ui && provider.auth === 'key') this._fillModels(provider, ui.model, ids, chosen);
  }
  if (!chosen) { if (ui) ui.connect.disabled = false; return say('Enter a model name.', false); }
  if (key) setKey(id, key);
  if (ui) ui.keyInput.value = '';
  setModelFor(id, chosen); setProviderId(id);
  this._activate(provider, chosen);
  if (ui) ui.connect.disabled = false;
 }

 _activate(provider, model, quiet = false) {
  const { engine, error } = engineFor(provider);
  if (error) { this._msg('error', error); return; }
  // A hosted System 2 replaces the on-device Qwen, which is unloaded to free GPU memory; Laya stays loaded
  // and keeps coaching as System 1.
  if (this._localEngine) { this._localEngine.unload?.(); this._localEngine = null; }
  this._resetTeacher(); this.teacher.setEngine(engine);
  this._active = { id: provider.id, model };
  if (quiet) { this._renderState(); return; }
  this._selected = provider.id;
  this._connected(provider);
 }

 _connected(provider) {
  this._renderProviders(); this._renderState();
  this._msg('info', provider.id === 'local'
   ? `${this.laya && this._localEngine ? 'Laya and Qwen are' : this.laya ? 'Laya is' : 'Qwen is'} ready. Play a phrase and pause${this._localEngine ? ', or ask a question' : ''}.`
   : `Connected to ${provider.name} as System 2. ${this.laya ? `Laya stays System 1: it coaches each phrase at once, and ${provider.name} explains.` : 'Load Laya (System 1) in the Provider tab for instant coaching; until then this model coaches too.'} Play a phrase and pause, or ask a question.`);
  this._showTab('lesson');
  document.activeElement?.blur?.(); // so the computer keyboard plays notes again straight away
 }

 _forget(provider) {
  clearKey(provider.id);
  if (this._active?.id === provider.id) { this._resetTeacher(); this.teacher.setEngine(null); this._active = null; }
  this._renderProviders(); this._renderState(); this._renderEmpty();
 }

 /* ---- Lesson tab ---- */

 _showClap(vel) {
  const live = this.panel?.querySelector('.tp-live');
  if (!live) return;
  live.querySelector('.tp-live-note').textContent = '👏';
  live.querySelector('.tp-live-detail').textContent = `Clap · velocity ${vel} · heard by Listening`;
  live.querySelector('.tp-chip').hidden = true;
 }
 // `heard`: a chord the Listening widget heard, which is approximate, and says so.
 _showLive(note, vel, heard = false) {
  const live = this.panel?.querySelector('.tp-live');
  if (!live) return;
  live.querySelector('.tp-live-note').textContent = pitchClassName(note);
  live.querySelector('.tp-live-detail').textContent = `MIDI ${note} · velocity ${vel} · pitch class ${note % 12}${heard ? ' · heard, approximate' : ''}`;
  const chip = live.querySelector('.tp-chip');
  const held = [...this.tracker.heldNotes];
  const chord = held.length >= 3 ? detectChord(held, Math.min(...held))[0] : null;
  chip.hidden = !chord; chip.textContent = chord?.chordName || '';
  this._chordName = chord?.chordName || '';
 }
 // Keys lit on the screen's keyboard for an exercise (light_pads with keys), for some seconds.
 _lightKeys(keys, seconds = 0) {
  const nums = keys.map(k => (Number.isInteger(k) ? k : midiOfName(k))).filter(m => m !== null);
  const els = nums.map(m => document.querySelector(`#keyboard [data-midi="${m}"]`)).filter(Boolean);
  document.querySelectorAll('#keyboard .teacher-hint').forEach(e => e.classList.remove('teacher-hint'));
  els.forEach(e => e.classList.add('teacher-hint'));
  clearTimeout(this._keysLit); if (seconds) this._keysLit = setTimeout(() => els.forEach(e => e.classList.remove('teacher-hint')), seconds * 1000);
  return els.length;
 }

 _showLocal(a) {
  const best = a.scales[0];
  this._add({ kind: 'local', title: best ? `${best.tonicName} ${best.scaleName}` : `${a.noteCount} notes`, chords: a.chords.map(c => c.best.chordName).join(' → '),
   detail: `${a.noteCount} notes${best ? ` · ${(best.score * 100).toFixed(0)}% match` : ''} · pitch classes ${a.pitchClasses.join(' ')}` });
 }

 _msg(type, text, play = null, info = {}) {
  const who = type !== 'teacher' ? '' : info.think ? `System 2 · ${this._who()}, thought for ${info.seconds.toFixed(1)} s` : `${this.laya ? 'System 2 · ' : ''}${this._who()}`;
  this._add({ kind: 'msg', type, text, play, who, exercise: info.exercise || null }, type === 'user' ? text : '');
 }
 _who() { return this._active?.id === 'local' ? 'Qwen' : providerById(this._active?.id)?.name || 'Teacher'; }

 // Everything in the conversation is an entry: drawn now, saved with the conversation, and drawn the same way
 // when it is reopened, buttons included.
 _add(entry, title = '') { this.convo.add(entry, title); const node = this._render(entry); this._append(node); return node; }

 _render(e) {
  const button = (text, onclick, primary = false) => el('button', { type: 'button', textContent: text, className: primary ? 'tp-primary' : '', onclick });
  const actions = (...buttons) => el('div', { className: 'tp-msg-actions' }, ...buttons.filter(Boolean));
  if (e.kind === 'local') {
   const d = el('div', { className: 'teacher-msg local' }, el('strong', { textContent: e.title }));
   if (e.chords) d.append(`Chords: ${e.chords}`);
   d.append(el('span', { className: 'tp-dim', textContent: e.detail }));
   return d;
  }
  if (e.kind === 'msg') {
   const d = el('div', { className: `teacher-msg ${e.type}` });
   if (e.who) d.append(el('span', { className: 'tp-who', textContent: e.who }));
   d.append(e.text);
   if (e.play || e.exercise) d.append(actions(e.play && button(`▶ ${e.play.label}`, () => this._playSteps(e.play.steps, e.play.bpm, e.play.label)), e.exercise && button(`Try this next: ${e.exercise.label}`, () => this._setExercise(e.exercise), true)));
   return d;
  }
  // A phrase's rhythm: the sixteenth grid bar by bar (each hit in its grade's colour), what happened, one thing
  // to do about it, what keeps happening, and the next exercise.
  if (e.kind === 'rhythm') {
   const grade = (bar, step) => e.grades?.find(g => g.bar === bar && g.step === step)?.grade || '';
   const grid = el('div', { className: 'tp-grid', title: 'Each row is a bar of sixteenth notes; the brighter cells are the beats' }, ...e.bars.map((b, bar) => el('div', { className: 'tp-bar' }, ...b.split('').map((c, step) => el('span', { className: `${step % 4 ? '' : 'beat'}${c === 'x' ? ` hit ${grade(bar, step)}` : ''}` })))));
   const why = this.teacher.isConfigured && e.msg && !(this.mode === 'slow' && this.autoAnalyze) && button('Explain why', () => { why.disabled = true; this._askedAt = performance.now(); this.teacher.ask(e.msg, { think: this.mode === 'slow' }); });
   return el('div', { className: 'teacher-msg rhythm' }, el('span', { className: 'tp-who', textContent: `${e.who} · rhythm` }), grid, el('p', { textContent: e.text }), el('p', { className: 'tp-fix', textContent: e.fix }),
    e.habit ? el('p', { className: 'tp-dim', textContent: `This keeps happening: ${e.habit}.` }) : '',
    actions(button(`Try this next: ${e.next.label}`, () => this._setExercise(e.next), true), why));
  }
  // Laya's step, and (in Fast mode) a way to ask System 2 why; highlighted when Laya judged it would help.
  if (e.kind === 'coach') {
   const d = el('div', { className: 'teacher-msg coach' }, el('span', { className: 'tp-who', textContent: e.who }), e.text);
   const why = e.why && this.teacher.isConfigured && button(e.why.suggested ? 'Explain why (suggested)' : 'Explain why', () => { why.disabled = true; this._queue(e.why.a, { think: true, coach: e.why.coach }); }, e.why.suggested);
   d.append(actions(button('▶ Hear it', () => this._playSteps(e.example.steps, e.example.bpm)), why));
   return d;
  }
  if (e.kind === 'lesson') return this._lessonCard(courseLesson(e.id));
  if (e.kind === 'passed') {
   const next = courseLesson(e.next);
   const go = next && button(`Next: ${next.title}`, () => { go.disabled = true; this._startLesson(next); }, true);
   return el('div', { className: 'teacher-msg info passed' }, `✓ ${e.text}`, next ? actions(go) : '');
  }
  if (e.kind === 'guide') return this._guideCard(e);
  // System 1's answer or tip: written words Laya chose, with the control to look at.
  if (e.kind === 's1') {
   const lesson = courseLesson(e.lesson);
   return el('div', { className: 'teacher-msg s1' }, el('span', { className: 'tp-who', textContent: e.who }), e.text,
    actions(e.play && button(`▶ ${e.play.label}`, () => this._playSteps(e.play.steps, e.play.bpm, e.play.label)), e.show && button('Show', () => ws.show(e.show)), e.guide && button('Full guide', () => { const w = ws.widgets().find(x => x.title === e.guide.title && x.plugin === e.guide.plugin); if (w) this._teachWidget(w); }),
     lesson && button(`Lesson: ${lesson.title}`, () => this._startLesson(lesson), true),
     e.q && this.teacher.isConfigured && button(`Ask ${this._who()}`, () => { this._msg('user', e.q); this._toSystem2(e.q); })));
  }
  // A sing-back: the phrase, each note marked, what to do, and Again / New phrase / Ask the provider about it
  // (with the take, when the provider may hear recordings).
  if (e.kind === 'singback') {
   const NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
   const chips = el('div', { className: 'tp-sing' }, ...e.notes.map(n => el('span', { className: `tp-sing-note ${n.got === null ? 'missed' : n.inTune && n.onTime ? 'good' : 'off'}`, textContent: `${NAMES[n.want % 12]}${n.got === null ? ' –' : ` ${n.inTune ? '✓' : `${n.cents > 0 ? '+' : '−'}${Math.abs(n.cents)}¢`}${n.onTime ? '' : ` ${n.ms > 0 ? 'late' : 'early'} ${Math.abs(n.ms)} ms`}`}` })));
   const audio = this._undos.get(`${e.id}:audio`);
   return el('div', { className: 'teacher-msg s1 singback' }, el('span', { className: 'tp-who', textContent: `${e.who} · sing it back` }), chips, e.text,
    actions(button('Again', () => this._singBack({ phrase: e.phrase })), button('New phrase', () => this._singBack({ length: e.phrase.length }), true),
     this.teacher.isConfigured && button(`Ask ${this._who()} about it${audio ? ' (with the recording)' : ''}`, () => { const q = `I sang back ${e.phrase.map(n => NAMES[n % 12]).join(' ')}. ${e.text} What should I work on?`; this._msg('user', q); this._toSystem2(q, [], { audio }); })));
  }
  // The agent's own entries: done (with Undo), suggested (Apply), waiting to be confirmed (Do it / Cancel),
  // refused (why), and Undo all for a turn's changes. After a reload the buttons are gone: the undo isn't kept.
  if (e.kind?.startsWith('agent-')) {
   const who = e.who ? el('span', { className: 'tp-who', textContent: e.who }) : '';
   const label = e.action ? e.action.replace(/_/g, ' ') : '';
   const once = (b, f, doneText) => { b.onclick = async () => { b.disabled = true; try { await f(); b.textContent = doneText; } catch (err) { b.textContent = 'Failed'; this._msg('info', err.message); } }; return b; };
   if (e.kind === 'agent-done') {
    const undo = this._undos.get(e.id);
    return el('div', { className: 'teacher-msg change agent' }, who, `Did: ${e.text}.`, undo ? actions(once(button('Undo'), undo, 'Undone')) : '');
   }
   if (e.kind === 'agent-batch') {
    const undo = this._undos.get(e.id);
    return el('div', { className: 'teacher-msg change agent' }, who, `${e.count} changes in this answer.`, undo ? actions(once(button(`Undo all ${e.count}`), undo, 'All undone')) : '');
   }
   if (e.kind === 'agent-suggest' || e.kind === 'agent-confirm') {
    const apply = this._undos.get(`${e.id}:apply`), row = actions();
    if (apply) {
     const go = once(button(e.kind === 'agent-confirm' ? 'Do it' : 'Apply', null, true), async () => { await apply(); row.querySelectorAll('button').forEach(x => { x.disabled = true; }); }, e.kind === 'agent-confirm' ? 'Done' : 'Applied');
     const no = button(e.kind === 'agent-confirm' ? 'Cancel' : 'Dismiss', () => { row.querySelectorAll('button').forEach(x => { x.disabled = true; }); no.textContent = 'Left as it was'; this._undos.delete(`${e.id}:apply`); });
     row.append(go, no);
    }
    return el('div', { className: `teacher-msg agent ${e.kind === 'agent-confirm' ? 'confirm' : 'suggest'}` }, who, e.kind === 'agent-confirm' ? `Asks first: ${label}?` : `Suggests: ${e.text}`, row);
   }
   return el('div', { className: 'teacher-msg info agent' }, who, `Couldn't ${label}: ${e.text}.`);
  }
  if (e.kind === 'change') {
   const undo = button('Undo', () => { if (ws.restore(e.name, e.raw)) { undo.disabled = true; undo.textContent = 'Undone'; } });
   const text = ws.LAYOUTS.includes(e.raw) ? `${e.name} is ${e.to} (it was ${e.fromText}).` : `Changed ${e.name} from ${e.fromText} to ${e.to}.`;
   return el('div', { className: 'teacher-msg change' }, e.who ? el('span', { className: 'tp-who', textContent: e.who }) : '', text, actions(button('Show', () => ws.show(e.name)), undo));
  }
  // Words that fit several controls: a button for each, and the one pressed is changed.
  if (e.kind === 'pick') {
   const row = actions(...e.choices.map(c => button(c.name.split(' › ').pop(), () => { row.querySelectorAll('button').forEach(b => { b.disabled = true; }); this._apply([c], 'System 1 · done at once'); })));
   return el('div', { className: 'teacher-msg s1' }, el('span', { className: 'tp-who', textContent: 'System 1' }), e.text, row);
  }
  return el('div', { className: 'teacher-msg info' }, e.text || '');
 }

 _append(node) {
  const c = this.panel?.querySelector('.tp-messages');
  if (!c || !node) return;
  c.querySelector('.tp-empty')?.remove();
  c.append(node);
  this._renderLive();
  while (c.querySelectorAll('.teacher-msg').length > MAX_MESSAGES) c.querySelector('.teacher-msg').remove();
  c.scrollTop = c.scrollHeight;
 }

 // Shows the current conversation: its entries, the model's memory of it, and a lesson left open.
 _loadConversation() {
  const c = this.convo.current, box = this.panel.querySelector('.tp-messages');
  this._resetTeacher();
  this.tracker.reset(); this._phraseQueue = []; this._coachHistory = []; this._stopPlayback(); this.voice?.cancelSpeech();
  this._endLesson(false); this._setExercise(null);
  box.replaceChildren();
  c.entries.forEach(e => this._append(this._render(e)));
  const open = courseLesson(c.lesson);
  if (open) this._resumeLesson(open);
  this._renderHistory(); this._renderEmpty();
 }
 // Stops whatever the model is doing; its memory stays the saved conversation's, so a new provider carries on.
 _resetTeacher() { this.teacher.reset(); this.teacher.conversationHistory = this.convo.current.history; }
 _renderHistory() {
  const sel = this.panel.querySelector('.tp-history');
  sel.replaceChildren(el('option', { value: '', textContent: this.convo.past.length ? 'History…' : 'No history' }), ...this.convo.past.map(c => el('option', { value: c.id, textContent: describeConversation(c) })));
  sel.disabled = !this.convo.past.length;
 }

 _ask() {
  const i = this.panel?.querySelector('.question-input');
  const q = i?.value.trim();
  if (!q) return;
  i.value = '';
  this._route(q);
 }
 // System 1 first: Laya answers questions about the workspace, its plug-ins and the course from the written
 // guides in well under a second. A request to compose or play something particular, or one Laya is unsure
 // about, goes to System 2 when one is connected.
 // Tested on real requests (Laya against Qwen 3.5 4B): Laya found the right control in a third of a second
 // where the guide's words could steer it, but it cannot compose and is unsure on its own, so System 2
 // supervises. Laya answers at once; System 2, when connected, checks that answer in the background and
 // only speaks up to correct it. A request to compose or play something particular goes to System 2.
 // A request to play something is met first by System 1's composer (js/requests.js), which reads the key,
 // chords and mood from the words and plays an exact example at once; in Slow mode System 2 then explains it.
 // Anything else that composes goes to System 2; questions about the app go to Laya.
 async _route(q) {
  if (this._voiceSpeedRequest(q)) return;
  if (AGENT.test(q) && this.teacher.isConfigured) return this._question(q); // a lesson set up, a practice track: System 2's
  const intent = readIntent(q);
  if (intent) return this._doIntent(q, intent);
  const req = await meetRequest(q, { last: this._lastExample, pick: this.laya ? (...a) => this.laya.pick(...a) : null }).catch(() => null);
  if (req) return this._playRequest(q, req);
  await this._learnAll(); // what each plug-in's controls are for, so "more reverb" finds the reverb's mix
  if (AGENT.test(q) && this.teacher.isConfigured) return this._question(q);
  if (await this._controllerCommand(q)) return;
  if (this._command(q)) return;
  const compose = COMPOSE.test(q);
  if (compose && this.teacher.isConfigured) return this._question(q, [], { compose });
  if (this.laya) return this._systemOneAsk(q, compose);
  if (this.teacher.isConfigured) return this._question(q);
  this._msg('user', q);
  this._msg('info', 'I can play what you ask for ("play a ii–V–I in G", "a sad progression in D minor") and change settings ("set the cutoff to 800", "turn on the metronome") right now. To answer questions, load Laya (System 1) or connect a provider in the Provider tab.');
  this._showTab('provider');
 }
 _playRequest(q, req) {
  this._msg('user', q);
  const play = { steps: req.steps, bpm: req.bpm, label: req.label };
  this._add({ kind: 's1', who: 'System 1 · played at once', text: req.say, play, q });
  const at = performance.now();
  this._say(req.say).then(() => { if (this._lastNoteAt <= at) this._playSteps(play.steps, play.bpm, play.label); });
  // Slow mode: System 2 explains what was played; its own example, if any, is offered rather than played.
  if (this.mode === 'slow' && this.teacher.isConfigured) { this._quietNext = true; this._toSystem2(q, [], { compose: true, quick: '', note: req.say }); }
 }
 _question(q, focus = [], opts = {}) { this._msg('user', q); this._toSystem2(q, focus, opts); }
 _toSystem2(q, focus = [], { compose = false, quick = '', onConfirm = null, note = '', audio = null } = {}) {
  this._askedAt = performance.now();
  const context = [this._workspaceContext(q, focus, compose), note && `[ALREADY PLAYED] The app has just played this for the student: ${note} Explain in two or three sentences what it is and why it fits the request.`].filter(Boolean).join('\n\n');
  this.agent.begin(); this._agentBusy = true;
  // A recording goes only when Settings › Listening and privacy allows it (the card offers it only then).
  if (audio && !read(AUDIO_TO_PROVIDER_KEY, false)) audio = null;
  return this.teacher.ask(q, { think: this.mode === 'slow', context, quick, onConfirm, tools: this._tools(), audio }).finally(() => {
   this._agentBusy = false;
   const done = this.agent.end().filter(r => r.undo);
   if (done.length > 1) { const id = `undo-${Date.now()}`; this._undos.set(id, () => done.reverse().forEach(r => r.undo())); this._add({ kind: 'agent-batch', id, count: done.length, who: `System 2 · ${this._who()}` }); }
  });
 }
 // The tools a hosted System 2 model may call while it answers (js/providers.js): read the widgets, a
 // widget's or plug-in's controls and what each does, change a control, hide, show or minimise a widget, and
 // point at a control. Changes go the same way as the student's requests: each listed with Show and Undo.
 _tools() {
  const name = { type: 'string', description: 'As the workspace names it: "Widget › Control", e.g. "Filter › Cutoff (Hz)" or "Delay › Mix"' };
  const fn = (n, description, properties = {}, required = []) => ({ type: 'function', function: { name: n, description, parameters: { type: 'object', properties, required } } });
  const definitions = [
   fn('list_widgets', 'Every widget, plug-in window and the Settings menu, one line each, with what each is doing.'),
   fn('get_controls', 'A widget\'s or plug-in\'s controls with their current values and ranges or options.', { widget: { type: 'string', description: 'Its title, e.g. "Filter", "Oscillators", "Reverb", "Settings"' } }, ['widget']),
   fn('describe_plugin', 'What a loaded plug-in is and what each of its controls does, with their values.', { plugin: { type: 'string', description: 'Its window title, e.g. "Delay"' } }, ['plugin']),
   fn('set_control', 'Change one control as the student would; it is listed for them with Undo. Numbers are clamped to the range; a choice is matched by its name; a switch takes true or false.', { control: name, value: { type: ['string', 'number', 'boolean'], description: 'The new value' } }, ['control', 'value']),
   fn('arrange_widget', 'Hide, show or minimise a whole widget.', { widget: { type: 'string' }, state: { type: 'string', enum: ['hidden', 'shown', 'minimised'] } }, ['widget', 'state']),
   fn('show_control', 'Point at a control: it is brought into view and pulses for a moment.', { control: name }, ['control']),
  ];
  definitions.push(...agentTools());
  const who = `System 2 · ${this._who()}`;
  const run = async (tool, a = {}) => {
   if (ACTIONS[tool]) return this.agent.call(tool, a, who);
   await this._learnAll();
   if (tool === 'list_widgets') return ws.describe([]);
   if (tool === 'get_controls' || tool === 'describe_plugin') {
    const hit = ws.find(a.widget ?? a.plugin);
    if (!hit) return `There is no widget or plug-in called "${a.widget ?? a.plugin}". ${ws.describe([])}`;
    const w = hit.widget, p = w.plugin && profiles.get(w.title);
    const lines = ws.describe([w.id]).split('\n').slice(1);
    if (p) lines.push(`${w.title} is ${KINDS[p.kind]?.says || 'a plug-in'}.`, ...ws.controls(w).filter(c => p.roles[c.label]).map(c => `${c.label}: ${ROLES[p.roles[c.label]]?.does || 'one of its settings'} (now ${ws.valueOf(c)}).`));
    return lines.join('\n');
   }
   if (tool === 'set_control' || tool === 'arrange_widget') {
    const change = { name: a.control ?? a.widget, value: a.value ?? a.state };
    if (this.agent.halted) return 'Stopped: the student pressed PANIC, so nothing more changes this turn.';
    if (!this.agentActs) { this._agentShow({ kind: 'suggest', action: tool, args: a, text: `${change.name} → ${change.value}`, who, apply: () => this._apply([change], who) }); return `Suggested to the student, who can apply it with one click: ${change.name} → ${change.value}.`; }
    const done = this._apply([change], who);
    return done.length ? `Done: ${done.join(', ')}.` : `Not changed. ${done.failed.join(' ')}`;
   }
   if (tool === 'show_control') { const shown = ws.show(a.control); return shown ? `Pointing at ${shown}.` : `There is no control called "${a.control}".`; }
   return `There is no tool called ${tool}.`;
  };
  return { definitions, run };
 }
 // Words that find each widget and plug-in: the written ones, and for a plug-in what was learned about it.
 _keywords() { return { ...KEYWORDS, ...Object.fromEntries([...profiles].map(([title, p]) => [title, [...KINDS[p.kind].words, ...Object.keys(p.roles)]])) }; }
 // The workspace as the model should see it for this question: every widget in a line, and the settings of
 // the ones the question (or an open workspace lesson) is about.
 // A request about the music only gets it when it names a widget: the workspace distracted Qwen from playing.
 _workspaceContext(q, focus = [], musicOnly = false) {
  const ids = [...new Set([...focus, ...(isWorkspace(this.lesson) ? ws.widgets().filter(w => w.title === this.lesson.widget).map(w => w.id) : []), ...ws.relevant(q, this._keywords())])];
  const ctl = (ABOUT_CONTROLLER.test(q) || isController(this.lesson)) && !musicOnly ? controllerContext() : '';
  if (!ids.length && (musicOnly || !ABOUT_APP.test(q))) return ctl;
  const learned = ws.widgets().filter(w => w.plugin && ids.includes(w.id) && profiles.has(w.title)).map(w => `What ${w.title} does: ${summarize(profiles.get(w.title))}`);
  return [`[WORKSPACE]\n${ws.describe(ids)}${learned.length ? `\n${learned.join('\n')}` : ''}`, ctl].filter(Boolean).join('\n\n');
 }

 // A reply's "show" points at controls one after another; "set" changes them, each with an Undo.
 // A model without tools writes its actions as { "do": [{ "action": …, …args }] }: they go through the agent, as a
 // tool call would. Its "set"s are suggested instead of made while the agent may not act.
 _act({ show = [], set = [], do: steps = [] }) {
  show.forEach((name, i) => setTimeout(() => ws.show(name), 600 + i * 1500));
  const who = `System 2 · ${this._who()}`;
  if (this.agentActs) this._apply(set.map(([name, value]) => ({ name, value })));
  else set.forEach(([name, value]) => this._agentShow({ kind: 'suggest', action: 'set_control', args: { control: name, value }, text: `${name} → ${value}`, who, apply: () => this._apply([{ name, value }], who) }));
  (async () => { for (const { action, ...args } of steps) await this.agent.call(action, args, who); })();
 }
 // What the agent did, suggests, or asks the student to confirm, in the conversation (js/agent-actions.js).
 _agentShow(e) {
  const id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  if (e.undo) this._undos.set(id, e.undo);
  if (e.apply) this._undos.set(`${id}:apply`, e.apply);
  this._add({ kind: `agent-${e.kind}`, id, action: e.action, text: e.text, who: e.who });
  if (e.kind === 'done') this._say?.(e.text);
 }
 // Makes changes as the student would, each listed with Show and Undo: a control is set, a whole widget is
 // hidden, shown or minimised. Returns what was done and what couldn't be, in words.
 _apply(list, who = '') {
  const done = [], failed = [];
  for (const { name, value } of list) {
   try {
    const hit = ws.find(name);
    if (hit && !hit.control && ws.LAYOUTS.includes(value)) {
     const r = ws.arrange(hit, value);
     this._add({ kind: 'change', who, name: r.name, raw: r.from, fromText: r.from, to: r.to });
     done.push(`${r.name} ${r.to}`);
     continue;
    }
    const fromText = hit?.control ? ws.valueOf(hit.control) : '';
    const r = ws.set(hit || name, value);
    this._add({ kind: 'change', who, name: r.name, raw: r.from, fromText, to: r.to });
    done.push(`${r.name.split(' › ').pop()} ${r.to}`);
   } catch (err) { failed.push(`${name}: ${err.message}`); this._msg('info', `${who ? 'I' : 'The teacher'} tried to change ${name}, but: ${err.message}`); }
  }
  return Object.assign(done, { failed });
 }
 // The controls as js/commands.js reads them, a plug-in's with the words and unit learned for each.
 _commandItems() {
  return ws.commandItems((w, c) => {
   const p = w.plugin && profiles.get(w.title);
   if (!w.plugin) return {};
   const words = p ? pluginWords(p.roles[c.label], p.kind, KINDS[p.kind]?.words || [], c.el) : {};
   // The unit the plug-in shows beside its slider ("375 ms") is surer than one guessed from the range.
   const shown = c.el.closest('.plugin-param')?.querySelector('output')?.textContent.match(/\s(ms|s|%|hz|khz)$/i)?.[1].toLowerCase();
   return shown && shown !== 'khz' ? { ...words, unit: shown } : words;
  });
 }
 // Requests about the controller met at once ("switch to the drum preset", "map the faders to the loop volumes",
 // "save this as my practice preset"): each goes through the agent, so it is listed with Undo, and one that
 // would replace something asks first.
 async _controllerCommand(q) {
  const calls = readControllerCommand(q);
  if (!calls) return false;
  this._msg('user', q);
  this.agent.begin();
  const said = [];
  for (const c of calls) said.push(await this.agent.call(c.action, c.args, 'System 1 · done at once'));
  const done = this.agent.end().filter(r => r.undo);
  if (done.length > 1) { const id = `undo-${Date.now()}`; this._undos.set(id, () => done.reverse().forEach(r => r.undo())); this._add({ kind: 'agent-batch', id, count: done.length, who: 'System 1 · done at once' }); }
  this._say(said.length > 1 ? `Done: ${done.map(r => r.text).join('; ')}.` : said[0]);
  return true;
 }
 // System 1 changes settings when asked, at once and with no model (js/commands.js): "set the cutoff to 800",
 // "turn off oscillator 2", "louder", "hide the oscilloscope". Words that fit several controls ask which, with
 // a button for each; anything it can't read goes on to Laya or System 2.
 _command(q) {
  const r = readCommand(q, this._commandItems());
  if (!r || r.problem) return false;
  this._msg('user', q);
  if (r.ask) {
   this._add({ kind: 'pick', text: r.ask.text, choices: r.ask.choices.map(c => ({ name: c.item.name, value: c.value })) });
   this._say(r.ask.text);
   return true;
  }
  const done = this._apply(r.changes.map(c => ({ name: c.item.name, value: c.value })), 'System 1 · done at once');
  r.already.forEach(a => this._msg('info', `${a.say}.`));
  this._say([done.length && `Done: ${done.join(', ')}.`, ...r.already.map(a => `${a.say.split(' › ').pop()}.`)].filter(Boolean).join(' '));
  return true;
 }

 /* ---- Widget guides ---- */

 // A 🎓 button in the title bar of every widget and plug-in window, including ones added later.
 _teachButtons() {
  const add = () => document.querySelectorAll('.widget-header:not([data-teach])').forEach(h => {
   h.dataset.teach = '1';
   const box = h.closest('.widget');
   const btn = el('button', { type: 'button', className: 'teach-btn', textContent: '🎓', title: 'Teach me this widget' });
   btn.setAttribute('aria-label', 'Teach me this widget');
   btn.onclick = () => { const w = ws.widgets().find(x => x.el === box); if (w) this._teachWidget(w); };
   h.append(btn); // after close, width and minimise
  });
  add();
  window.addEventListener('load', () => setTimeout(add, 0));
  // Plug-in windows live in a layer the plug-in host creates on first use.
  const watch = layer => new MutationObserver(add).observe(layer, { childList: true });
  const layer = document.querySelector('.plugin-windows');
  if (layer) watch(layer);
  else new MutationObserver((_, obs) => { const l = document.querySelector('.plugin-windows'); if (l) { obs.disconnect(); watch(l); add(); } }).observe(document.body, { childList: true });
  // With Laya loaded, a plug-in the student adds gets its guide and a first tip straight away. The host's
  // status line says "Loaded …" only for plug-ins added now, not for ones restored from the last visit.
  const hostStatus = () => document.querySelector('#plugin-host-module [role=status]');
  const watchHost = node => new MutationObserver(() => {
   if (!this.laya || !this.enabled || !/^Loaded /.test(node.textContent)) return;
   setTimeout(() => {
    const w = ws.widgets().filter(x => x.plugin).at(-1);
    if (w) { this._setOpen(true); this._showTab('lesson'); this._meetPlugin(w); }
   }, 300);
  }).observe(node, { childList: true, characterData: true, subtree: true });
  if (hostStatus()) watchHost(hostStatus()); else window.addEventListener('load', () => { const n = hostStatus(); if (n) watchHost(n); });
 }

 async _teachWidget(w) {
  if (w.plugin) await this._learn(w);
  this._setOpen(true); this._showTab('lesson');
  this._add({ kind: 'guide', title: w.title, plugin: w.plugin }, `${w.title} guide`);
  ws.show({ widget: w, control: null });
 }

 // A widget's guide: what it is for and how to use it, each step with a Show button; its lesson if the course
 // has one; and, with a model connected, a question about it that comes with the widget's live settings.
 _guideCard(e) {
  const w = ws.widgets().find(x => x.title === e.title && x.plugin === e.plugin);
  const g = w ? guideFor(w) : null;
  const d = el('div', { className: 'teacher-msg guide' }, el('span', { className: 'tp-who', textContent: e.plugin ? 'Plug-in guide' : 'Widget guide' }), el('strong', { textContent: e.title }));
  if (!w) { d.append(el('p', { textContent: 'This widget is not in the workspace any more.' })); return d; }
  if (g) {
   d.append(el('p', { textContent: g.what }));
   d.append(el('ol', { className: 'tp-steps' }, ...g.how.map(([text, target]) => el('li', {}, text, target && ws.find(target) ? el('button', { type: 'button', textContent: 'Show', onclick: () => ws.show(target) }) : ''))));
  }
  if (e.plugin) {
   const params = ws.controls(w).filter(c => c.kind === 'number').map(c => c.label);
   if (params.length) d.append(el('p', { textContent: `Its controls: ${params.join(', ')}.` }));
  }
  const lesson = WORKSPACE_LESSONS.find(l => l.widget === e.title);
  const row = el('div', { className: 'tp-msg-actions' });
  if (this.laya) row.append(el('button', { type: 'button', className: 'tp-primary', textContent: 'Next tip', onclick: () => this._nextTip(e.title, e.plugin) }));
  if (lesson) row.append(el('button', { type: 'button', textContent: `${this.courseDone.has(lesson.id) ? '✓ ' : ''}Lesson: ${lesson.title}`, onclick: () => this._startLesson(lesson) }));
  if (this.teacher.isConfigured) row.append(el('button', { type: 'button', textContent: 'Ask the teacher', onclick: () => this._question(`How do I use the ${e.title} ${e.plugin ? 'plug-in' : 'widget'}, and what would you try first with the settings it has now?`, [w.id]) }));
  if (row.childNodes.length) d.append(row);
  return d;
 }


 /* ---- Learning plug-ins ---- */

 // What a plug-in can do, learned once and remembered: its kind and what each control does, read from the
 // names, with Laya (when loaded) settling what the names don't say. A profile made from names alone is
 // learned again by Laya once it is loaded, if anything was left unexplained.
 async _learn(w) {
  const params = ws.controls(w).filter(c => (c.kind === 'number' || c.kind === 'select') && isSoundControl(c)).map(c => ({ label: c.label, min: c.el.min ?? '', max: c.el.max ?? '' }));
  let p = cachedProfile(w.title, params);
  const vague = p && !p.byLaya && (p.kind === 'other' || Object.values(p.roles).includes('other'));
  if (!p || (vague && this.laya)) {
   p = await learnPlugin(w.title, params, { instrument: /Instrument/.test(w.el.textContent), laya: this.laya }).catch(() => learnPlugin(w.title, params, { instrument: /Instrument/.test(w.el.textContent) }));
   keepProfile(p, params);
  }
  profiles.set(w.title, p);
  return p;
 }
 _learnAll() { return Promise.all(ws.widgets().filter(w => w.plugin && !profiles.has(w.title)).map(w => this._learn(w))); }

 // A plug-in the student has just added: Laya learns it, says what it found, and gives the first tip.
 async _meetPlugin(w) {
  const p = await this._learn(w);
  const text = p.byLaya ? `Laya learned ${w.title} in ${p.ms} ms: it is ${KINDS[p.kind].says}.` : `${w.title} is ${KINDS[p.kind].says}.`;
  this._add({ kind: 's1', who: 'System 1 · Laya', text, show: w.title, guide: { title: w.title, plugin: true } });
  this._nextTip(w.title, true);
 }

 /* ---- System 1 teaching the workspace ---- */

 // A question answered by Laya alone: it picks the widget (or lesson) and the guide step, and the control lights up.
 async _systemOneAsk(q, compose = false) {
  this._msg('user', q);
  this._setStatus('coaching');
  try {
   await this._learnAll();
   const r = await systemOneAnswer(q, { pick: (...a) => this.laya.pick(...a), widgets: ws.widgets(), hint: ws.relevant(q, this._keywords(), 3) });
   this._setStatus(null);
   const who = `System 1 · Laya, ${r.ms} ms`;
   let entry, focus = [];
   if (r.lesson) {
    entry = { kind: 's1', who, text: `That's in the lesson "${r.lesson.title}": ${r.lesson.text.split(/(?<=\.)\s/)[0]}`, lesson: r.lesson.id, q };
   } else {
    const g = guideFor(r.widget), show = r.step?.[1] || r.widget.title;
    entry = { kind: 's1', who, text: `${r.widget.title}: ${r.step ? r.step[0] : g?.what || 'see its guide.'}`, show, guide: { title: r.widget.title, plugin: r.widget.plugin }, q };
    focus = [r.widget.id];
    ws.show(show);
   }
   let node = this._add(entry); this._say(entry.text);
   // Slow mode: System 2 checks Laya's answer and speaks up only to correct it. (In tests Qwen 3.5 4B never
   // confirmed and sometimes "corrected" right answers, so Fast mode trusts Laya and offers "Ask" instead.)
   if (this.teacher.isConfigured && this.mode === 'slow') this._toSystem2(q, focus, { quick: entry.text, onConfirm: () => { entry.who += ` · checked by ${this._who()}`; const fresh = this._render(entry); node.replaceWith(fresh); node = fresh; this.convo.save(); } });
   else if (compose && !this.teacher.isConfigured) this._msg('info', 'Laya chooses from what is written, so it can\'t compose. Load Qwen or connect a provider to have the teacher play something new.');
  } catch (err) { this._setStatus(null); this._msg('error', `Laya couldn't answer: ${err.message}`); }
 }

 // The next control to try in a widget or plug-in, chosen by Laya from its current settings.
 async _nextTip(title, plugin) {
  const w = ws.widgets().find(x => x.title === title && x.plugin === plugin);
  if (!w || !this.laya) return;
  if (plugin) await this._learn(w);
  const key = `${plugin ? 'plugin' : 'widget'}:${title}`, given = (this._tips ||= {})[key] ||= [];
  const controls = ws.controls(w).map(c => ({ label: c.label, kind: c.kind, value: ws.valueOf(c), min: c.el.min ?? '', max: c.el.max ?? '', id: c.el.id }));
  this._setStatus('coaching');
  try {
   const tip = await nextTip(w, { pick: (...a) => this.laya.pick(...a), controls, given });
   if (!tip) { given.length = 0; this._msg('info', `That's every control in ${title}. Press Next tip again to go round once more.`); }
   else {
    given.push(tip.label);
    this._add({ kind: 's1', who: `System 1 · Laya, ${tip.ms} ms`, text: tip.text, show: tip.target, guide: null });
    ws.show(tip.target); this._say(tip.text);
   }
  } catch (err) { this._msg('error', `Laya couldn't choose: ${err.message}`); }
  this._setStatus(null);
 }

 /* ---- Course ---- */

 _renderCourse() {
  const list = this.panel.querySelector('.tp-course');
  list.replaceChildren();
  for (const unit of COURSE_UNITS) {
   list.append(el('h3', { className: 'tp-group-title', textContent: unit }));
   // What the teacher has noticed about the student's timing, which it plans their exercises from.
   const habits = unit === RHYTHM_UNIT && issues(this.rhythmProfile, timing.level);
   if (habits?.length) list.append(el('p', { className: 'tp-habits', textContent: `Noticed in your playing: ${habits.map(h => h.text).join('; ')}. Your exercises lean on it.` }));
   for (const l of COURSE.filter(x => x.unit === unit)) {
    const done = this.courseDone.has(l.id);
    const item = el('button', { type: 'button', className: `tp-lesson-item${done ? ' done' : ''}${this.lesson === l ? ' current' : ''}` },
     el('span', { className: 'tp-lesson-n', textContent: done ? '✓' : COURSE.indexOf(l) + 1 }), el('span', { textContent: l.title }));
    if (done) item.title = 'Done; do it again any time';
    item.onclick = () => this._startLesson(l);
    list.append(item);
   }
  }
 }

 // A lesson card: the idea, the task, the example (or, for a workspace lesson, the controls to use), and a
 // link to the chapter it comes from.
 _lessonCard(l) {
  if (!l) return null;
  const card = el('div', { className: 'teacher-msg lesson' },
   el('span', { className: 'tp-who', textContent: `Lesson ${COURSE.indexOf(l) + 1} of ${COURSE.length} · ${l.unit}` }),
   el('strong', { textContent: l.title }), el('p', { textContent: l.text }), el('p', { className: 'tp-task', textContent: `Your turn: ${l.task}` }));
  const actions = el('div', { className: 'tp-msg-actions' });
  if (l.example) actions.append(el('button', { type: 'button', textContent: '▶ Hear the example', onclick: () => this._playSteps(l.example.steps, l.example.bpm) }));
  if (l.show) actions.append(el('button', { type: 'button', textContent: 'Show me', onclick: () => this._showTargets(l.show) }));
  if (this.teacher.isConfigured) actions.append(el('button', { type: 'button', textContent: 'Explain more', onclick: () => this._explainLesson(l) }));
  card.append(actions);
  if (l.page) card.append(el('a', { href: l.page, target: '_blank', rel: 'noopener', textContent: 'Read the chapter in Open Music Theory ↗' }));
  return card;
 }
 _showTargets(targets = []) { targets.forEach((t, i) => setTimeout(() => ws.show(t), i * 1500)); }

 // Starts a lesson: its card goes into the conversation, the example plays (or the controls light up), and
 // from here on what the student plays and changes is checked against the task.
 _startLesson(l) {
  this._add({ kind: 'lesson', id: l.id }, l.title);
  this._resumeLesson(l);
  this._setOpen(true); this._showTab('lesson');
  document.activeElement?.blur?.(); // so the computer keyboard plays notes straight away
  const at = performance.now();
  this._say(`${l.title}. ${l.text} Your turn: ${l.task}`).then(() => {
   if (this._lastNoteAt > at || this.lesson !== l) return;
   if (l.example) this._playSteps(l.example.steps, l.example.bpm); else this._showTargets(l.show);
  });
 }
 // Makes a lesson the open one without posting its card again (when a saved conversation is reopened).
 _resumeLesson(l) {
  this._endLesson(false);
  this.lesson = l; this.attempt.reset(); this._lessonMisses = 0;
  this.convo.setLesson(l.id);
  const bar = this.panel.querySelector('.tp-lesson-bar');
  bar.hidden = false; bar.querySelector('span').textContent = `Lesson ${COURSE.indexOf(l) + 1}: ${l.title}`;
  bar.querySelector('.tp-lesson-hear').textContent = l.example ? '▶ Example' : 'Show me';
  // Workspace tasks finish with a click or a slider move as often as with a note, so they are checked as
  // the student works, not only when a phrase ends.
  if (isWorkspace(l) || isController(l)) this._lessonTimer = setInterval(() => this._checkLesson(true), 700);
  if (isController(l)) { this._lessonSince = performance.now(); const d = controllers.active[0]; if (d) try { l.setup?.(d); } catch (err) { this._msg('info', err.message); } else this._msg('info', 'This lesson is for a MIDI controller: plug one in (the Controllers widget shows it) and start it again.'); }
  this._renderCourse();
 }

 _endLesson(save = true) {
  if (isController(this.lesson)) { const d = controllers.active[0]; if (d) try { this.lesson.teardown?.(d); } catch { /* it was unplugged */ } }
  this.lesson = null; this.attempt.reset(); clearTimeout(this._missTimer); clearInterval(this._lessonTimer);
  if (save) this.convo.setLesson(null);
  this.panel.querySelector('.tp-lesson-bar').hidden = true;
  this._renderCourse();
 }

 // A pass says what was done and offers the next lesson; a miss gives the hint once the student has stopped
 // playing, and after a few misses suggests the example or asking for more. Checks from the timer stay quiet.
 _checkLesson(quiet = false) {
  const l = this.lesson;
  if (!l) return;
  const passed = isWorkspace(l) ? l.check(this.attempt, ws.state()) : isController(l) ? l.check(this.attempt, lessonState(this._lessonSince)) : l.check(this.attempt);
  if (passed) {
   this.courseDone.add(l.id); save('teacher-course-v1', [...this.courseDone]);
   this._endLesson();
   const next = nextInCourse(l.id);
   const text = `Well done: ${typeof passed === 'string' ? `that's ${passed}` : 'you\'ve got it'}.${next ? '' : ' That was the last lesson in the course.'}`;
   this._add({ kind: 'passed', text, next: next?.id || null });
   this._say(text);
   return;
  }
  if (quiet) return;
  // A pause between chords ends a phrase too, so a miss is only reported once the student has stopped playing.
  clearTimeout(this._missTimer);
  this._missTimer = setTimeout(() => {
   if (this.lesson !== l) return;
   this._lessonMisses++;
   const more = this._lessonMisses >= 3 ? ` ${l.example ? 'Listen to the example again' : 'Tap Show me'}${this.teacher.isConfigured ? ', or tap Explain more' : ''}.` : '';
   this._msg('info', `Not yet. ${l.hint}${more}`);
  }, 2500);
 }

 _explainLesson(l) {
  if (!this.teacher.isConfigured) { this._showTab('provider'); return; }
  this._askedAt = performance.now();
  this._msg('user', `Tell me more about ${l.title.toLowerCase()}.`);
  const focus = isWorkspace(l) ? ws.widgets().filter(w => w.title === l.widget).map(w => w.id) : [];
  const prompt = isWorkspace(l) ? `The student is on the workspace lesson "${l.title}". It says: ${l.text} Their task: ${l.task} Explain it a little more, using the widget's real controls, and point at the control to use.` : explainPrompt(l);
  this.teacher.ask(prompt, { think: this.mode === 'slow', context: focus.length ? `[WORKSPACE]\n${ws.describe(focus)}` : '' });
 }

 /* ---- Saved in this browser ---- */

 // Downloaded models and saved conversations, each with a way to clear it.
 async _renderStorage() {
  const box = this.panel.querySelector('.tp-storage');
  const status = el('p', { className: 'tp-card-status', role: 'status' });
  const models = el('span', { className: 'tp-note', textContent: 'Checking downloaded models…' });
  const clearModels = el('button', { type: 'button', textContent: 'Clear downloaded models' });
  const convos = el('span', { className: 'tp-note', textContent: `${this.convo.count} saved conversation${this.convo.count === 1 ? '' : 's'}` });
  const clearConvos = el('button', { type: 'button', textContent: 'Clear saved conversations', disabled: !this.convo.count });
  box.replaceChildren(el('h3', { className: 'tp-group-title', textContent: 'Saved in this browser' }),
   el('div', { className: 'tp-row' }, models, clearModels), el('div', { className: 'tp-row' }, convos, clearConvos), status);
  clearConvos.onclick = () => {
   if (!confirm('Delete every saved conversation with the teacher, including this one?')) return;
   this.convo.clearAll(); this._loadConversation(); this._renderStorage();
  };
  clearModels.onclick = async () => {
   if (!confirm('Delete the downloaded on-device models? They download again the next time you load them.')) return;
   clearModels.disabled = true;
   try { const n = await clearModelCache(); save('teacher-laya-auto-v1', false); status.className = 'tp-card-status ok'; status.textContent = n ? `Deleted. A model that is loaded keeps working until you reload the page.` : 'There was nothing to delete.'; }
   catch (err) { status.className = 'tp-card-status bad'; status.textContent = `Couldn't delete them: ${err.message}`; }
   this._renderStorage().then(() => { box.querySelector('.tp-card-status').replaceWith(status); });
  };
  try {
   const info = await modelCacheInfo();
   const names = [info.laya && 'Laya', ...info.qwen, ...info.voices].filter(Boolean);
   models.textContent = names.length ? `Downloaded models: ${names.join(', ')}${info.bytes ? ` (this site stores ${formatBytes(info.bytes)})` : ''}` : 'No models downloaded';
   clearModels.disabled = !info.caches.length;
  } catch { models.textContent = 'Downloaded models: unknown'; }
 }

 /* ---- Talk mode ---- */

 // Reads text aloud when talk mode is on; resolves straight away otherwise.
 _say(text) { return this.talking && this.voice ? this.voice.speak(text) : Promise.resolve(); }

 // Talk is voice mode: speech recognition hears questions, and the Listening widget (opened if it wasn't) hears
 // singing and playing in the same microphone, hands-free (js/voice-mode.js).
 async _toggleTalk() {
  if (this.talking) { this.voice.stop(); return; }
  this._makeVoice();
  this.voice.start();
  if (!listening.active) { this._voiceOpened = true; if (!(await listening.start())) { this._voiceOpened = false; this._msg('info', `Voice mode hears questions only: ${listening.error}`); return; } }
  listening.voiceMode(true);
  this._renderPtt();
 }
 _renderPtt() { const b = this.panel?.querySelector('.tp-ptt'); if (b) b.hidden = !(this.talking && listening.voice); }

 // A finished spoken question: routed like a typed one.
 // In voice mode, what recognition heard counts only when the microphone heard talk (or Hold to talk was held):
 // words it makes of singing are left.
 _heard(text) {
  this.panel.querySelector('.question-input').value = '';
  const v = listening.voice, now = performance.now();
  if (v && listening.active && !(now < (this._pttUntil || 0)) && !v.sm.wasSpeech(now)) { this._msg('info', `(Heard "${text}" while you were singing, so not taken as a question. Hold to talk to be sure.)`); return; }
  this._route(text);
 }
 // A request System 1 meets with one of the app's actions (js/voice-mode.js readIntent): done at once, as the
 // student asked for it, listed with Undo.
 async _doIntent(q, intent) {
  this._msg('user', q);
  if (intent.action === 'sing_back') { this._say(intent.say); return this._singBack(); }
  const args = { ...intent.args };
  if (intent.action === 'stop_loop_recording' && !args.slot) { const k = window.synth.loops().findIndex(l => l.recording); if (k < 0) { this._msg('info', 'No loop slot is recording.'); return; } args.slot = k + 1; }
  try {
   const r = await ACTIONS[intent.action].run(args, this.agent.env);
   this._agentShow({ kind: 'done', action: intent.action, args, text: r.text, who: 'System 1 · done at once', undo: r.undo });
   this._say(intent.say);
  } catch (err) { this._msg('info', `I couldn't do that: ${err.message}.`); }
 }

 /* ---- Sing it back ---- */

 // A phrase in the sequencer's key, in the range the student last sang in (or around middle C), plays from the
 // next bar against the metronome; the student sings it back in the bar after; each note is then marked in tune
 // or not, early or late (js/voice-mode.js scoreSingBack). With the provider allowed to hear recordings (Settings),
 // the take is kept, to send if they ask.
 async _singBack({ phrase = null, length = 4 } = {}) {
  if (this._singing) return;
  if (!listening.active && !(await listening.start())) { this._msg('info', `Sing it back needs the microphone: ${listening.error}`); return; }
  this._singing = true;
  try {
   if (listening.settings.mode !== 'melody') { const m = document.getElementById('listen-mode'); if (m) { m.value = 'melody'; m.dispatchEvent(new Event('change')); } else listening.set({ mode: 'melody' }); }
   const sung = listening.take.slice(-12).map(n => n.midi), centre = sung.length ? Math.round(sung.sort((a, b) => a - b)[sung.length >> 1]) : 60;
   const { key, intervals } = keyAndScale();
   phrase ||= makePhrase({ key, intervals, low: centre - 6, high: centre + 6, length: Math.max(3, Math.min(8, length)) });
   const m = document.getElementById('metronomeToggle');
   if (m && !m.checked) m.click();
   for (let i = 0; i < 100 && !timing.clock.external; i++) await new Promise(r => setTimeout(r, 20));
   const c = timing.clock, beat = c.period, bar = c.beatsPerBar, now = performance.now();
   const start = c.timeOf(Math.ceil((c.beatAt(now) + 1) / bar) * bar), reply = start + Math.ceil(phrase.length / bar) * bar * beat;
   const target = this.singBackTarget = phrase.map((midi, i) => ({ midi, time: reply + i * beat })); // for whoever drives it (the tests)
   this._later(start - now, () => this._playSteps(phrase.map(n => [n]), 60000 / beat, 'Sing it back'));
   this._add({ kind: 'info', text: `Sing it back: listen to ${phrase.length} notes from the next bar, then sing them in the bar after, one a beat.` });
   const heard = [], open = new Map(), off = listening.subscribe((type, e) => {
    if (type !== 'note') return;
    if (e.type === 'on') open.set(e.midi, { midi: e.midi, start: e.time }); else if (open.has(e.midi)) { heard.push({ ...open.get(e.midi), end: e.time }); open.delete(e.midi); }
   });
   const keepTake = read(AUDIO_TO_PROVIDER_KEY, false) && this.teacher.isConfigured;
   let take = null;
   await new Promise(r => setTimeout(r, Math.max(0, reply - beat - performance.now())));
   if (keepTake) take = await listening.record().catch(() => null);
   await new Promise(r => setTimeout(r, Math.max(0, reply + phrase.length * beat + 500 - performance.now())));
   off();
   for (const n of open.values()) heard.push({ ...n, end: performance.now() });
   const score = scoreSingBack(target, heard.sort((a, b) => a.start - b.start), { trail: listening.trail, beatMs: beat });
   let audio = null;
   if (take) {
    const t = await take.stop(), bytes = new Uint8Array(await encodeAudio([t.samples], t.sampleRate, 'wav16').arrayBuffer());
    let text = ''; for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    audio = btoa(text);
   }
   const id = `sing-${Date.now()}`;
   if (audio) this._undos.set(`${id}:audio`, audio);
   this._add({ kind: 'singback', id, phrase, notes: score.notes, text: score.text, who: 'System 1' });
   this._say(score.text);
   return score;
  } finally { this._singing = false; }
 }

 _makeVoice() {
  this.voice ||= new Voice({
   localOnly: () => read(SPEECH_LOCAL_KEY, true),
   onHeard: text => this._heard(text),
   onInterim: text => { this.panel.querySelector('.question-input').value = text; },
   onState: (state, note) => this._talkState(state, note),
  });
  this.voice.setVoice(this.voiceChoice); this.voice.setSpeed(this.voiceSpeed);
  this.voice.onProgress = p => { const line = this.panel.querySelector('.tp-talk-note'); line.hidden = false; line.textContent = `Getting the voice ready: ${p.text || ''}${typeof p.progress === 'number' ? ` ${Math.round(p.progress * 100)}%` : ''}`; };
  return this.voice;
 }

 // The voice that reads replies in talk mode: the browser's, or a neural voice that runs in the page.
 async _renderVoices() {
  const box = this.panel.querySelector('.tp-voices');
  const select = el('select'), about = el('p', { className: 'tp-note' }), status = el('p', { className: 'tp-card-status', role: 'status' });
  const test = el('button', { type: 'button', textContent: 'Test voice' });
  const speed = el('input', { type: 'range', className: 'tp-voice-speed', min: VOICE_SPEED.min, max: VOICE_SPEED.max, step: VOICE_SPEED.step, value: this.voiceSpeed });
  const shows = el('output', { textContent: `${this.voiceSpeed.toFixed(2)}×` });
  speed.setAttribute('aria-label', 'How fast the teacher talks');
  speed.oninput = () => { this._setVoiceSpeed(Number(speed.value)); shows.textContent = `${this.voiceSpeed.toFixed(2)}×`; };
  speed.ondblclick = () => { speed.value = VOICE_SPEED.normal; speed.oninput(); };
  box.replaceChildren(el('h3', { className: 'tp-group-title', textContent: 'Teacher\'s voice' }), el('label', { className: 'tp-field' }, 'Reads replies aloud in talk mode', select), about,
   el('label', { className: 'tp-field tp-speed' }, el('span', {}, 'Speed ', shows), speed), el('p', { className: 'tp-note', textContent: 'Slower or faster without changing the voice\'s pitch; double-click for its own speed. You can also say "talk slower" or "speak faster".' }),
   el('div', { className: 'tp-row' }, test), status);
  select.append(el('option', { value: 'browser|', textContent: 'Browser voice (built in, no download)' }));
  const engines = {};
  for (const id of Object.keys(VOICE_ENGINES)) {
   try {
    const { ENGINE } = await loadEngine(id); engines[id] = ENGINE;
    select.append(el('optgroup', { label: ENGINE.name }, ...ENGINE.voices.map(v => el('option', { value: `${id}|${v.id}`, textContent: `${v.label}${v.id === ENGINE.defaultVoice ? ' · recommended' : ''}` }))));
   } catch { /* an engine that can't load here isn't offered */ }
  }
  const current = () => { const [engine, voice] = select.value.split('|'); return { engine, voice }; };
  const describe = () => { const e = engines[current().engine]; about.textContent = e ? `${e.about} ${e.license}` : 'The browser\'s own voice: nothing to download, but it sounds less natural.'; };
  const chosen = this.voiceChoice.engine === 'browser' ? 'browser|' : `${this.voiceChoice.engine}|${this.voiceChoice.voice || engines[this.voiceChoice.engine]?.defaultVoice || ''}`;
  select.value = [...select.options].some(o => o.value === chosen) ? chosen : 'browser|';
  describe();
  select.onchange = () => { this.voiceChoice = current(); save('teacher-voice-v1', this.voiceChoice); this.voice?.setVoice(this.voiceChoice); describe(); status.textContent = ''; };
  test.onclick = async () => {
   const v = this._makeVoice();
   test.disabled = true; status.className = 'tp-card-status'; status.textContent = 'Getting the voice ready…';
   v.onProgress = p => { status.textContent = `${p.text || 'Downloading'}${typeof p.progress === 'number' ? ` ${Math.round(p.progress * 100)}%` : ''}`; };
   try { await v.speak('Hi! Play a phrase and pause, and I\'ll tell you what you played and what to try next.'); status.className = 'tp-card-status ok'; status.textContent = 'That is the voice talk mode uses.'; }
   catch (err) { status.className = 'tp-card-status bad'; status.textContent = err.message; }
   test.disabled = false; this._makeVoice();
  };
 }

 // How fast the teacher talks (0.5–2×, kept): from the Speed slider, or asked for in words.
 _setVoiceSpeed(x) {
  this.voiceSpeed = Math.min(VOICE_SPEED.max, Math.max(VOICE_SPEED.min, x));
  save('teacher-voice-speed-v1', this.voiceSpeed); this.voice?.setSpeed(this.voiceSpeed);
  const slider = this.panel.querySelector('.tp-voice-speed');
  if (slider && Number(slider.value) !== this.voiceSpeed) { slider.value = this.voiceSpeed; slider.oninput(); }
 }
 _voiceSpeedRequest(q) {
  const x = speedFrom(q, this.voiceSpeed);
  if (x === null) return false;
  this._msg('user', q);
  this._setVoiceSpeed(x);
  this._msg('info', `I'll talk at ${this.voiceSpeed.toFixed(2).replace(/\.?0+$/, '')}× ${this.voiceSpeed === 1 ? '(my own speed)' : this.voiceSpeed > 1 ? 'faster' : 'slower'} now. The Speed slider in the Provider tab changes it too.`);
  this._say(this.voiceSpeed === 1 ? 'Back to my own speed.' : `Like this, at ${this.voiceSpeed.toFixed(2).replace(/\.?0+$/, '')} times.`);
  return true;
 }

 _talkState(state, note) {
  if (state === 'voice-error') { this._msg('info', `The chosen voice couldn't start (${note}), so the browser's voice reads replies for now.`); return; }
  this.talking = state === 'listening' || state === 'speaking';
  listening.hush = state === 'speaking' && !listening.settings.headphones; // on speakers, what the microphone hears now is the teacher
  if (!this.talking) { listening.voiceMode(false); if (this._voiceOpened) { listening.stop(); this._voiceOpened = false; } }
  this._renderPtt();
  const btn = this.panel.querySelector('.tp-talk'), line = this.panel.querySelector('.tp-talk-note');
  btn.setAttribute('aria-pressed', this.talking);
  btn.classList.toggle('listening', state === 'listening');
  btn.textContent = state === 'listening' ? '🎙 Listening' : state === 'speaking' ? '🔊 Speaking' : '🎙 Talk';
  if (state === 'error') { this._msg('error', note); this.panel.querySelector('.question-input').value = ''; }
  if (!this.talking) { line.hidden = true; return; }
  const how = !canListen() ? 'This browser can\'t listen, so talk mode only reads replies aloud.'
   : this.voice.cannotListen ? 'This browser recognises speech only online, which ☰ Settings › Listening and privacy doesn\'t allow, so it hears your singing and playing, and reads replies aloud; type your questions.'
   : this.voice.local ? 'Speech is recognised on this device.'
   : 'Your browser\'s speech service recognises what you say (in Chrome that is online).';
  const both = listening.voice ? ' Sing or play too: it tells talk from singing, or hold Hold to talk.' : '';
  line.hidden = false;
  line.textContent = state === 'speaking' ? 'Speaking. Play a note to interrupt.' : `Listening: ask a question out loud, or play and pause.${both} ${how}`;
 }
}

let _bridge = null;
export function initTeacher() { if (_bridge) return _bridge; _bridge = new TeacherBridge(); _bridge.hook(); return _bridge; }
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTeacher);
else initTeacher();
