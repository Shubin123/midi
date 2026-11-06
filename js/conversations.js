// Conversations with the teacher, kept in the browser so they survive a reload: the entries shown in the panel
// (messages, coaching steps, lessons, guides) and the model's message history, so it remembers the
// conversation too. "New" starts a fresh conversation and the old one moves to a short history, from which
// it can be reopened and continued.
import { read, save } from './storage.js';

const KEY = 'teacher-conversations-v1';
export const KEEP = 12, MAX_ENTRIES = 200;

const fresh = () => ({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), started: Date.now(), title: '', entries: [], history: [], lesson: null });

export class Conversations {
 constructor(store = { read, save }) {
  this.store = store;
  const data = store.read(KEY, null);
  this.current = data?.current?.entries ? data.current : fresh();
  this.past = Array.isArray(data?.past) ? data.past.filter(c => c?.entries) : [];
  this._timer = null;
 }
 // Saving waits a moment, so a burst of messages is written once.
 save(now = false) {
  clearTimeout(this._timer);
  const write = () => this.store.save(KEY, { current: this.current, past: this.past });
  if (now) write(); else this._timer = setTimeout(write, 300);
 }
 add(entry, title = '') {
  const c = this.current;
  c.entries.push(entry);
  if (c.entries.length > MAX_ENTRIES) c.entries.splice(0, c.entries.length - MAX_ENTRIES);
  if (!c.title && title) c.title = title.slice(0, 60);
  this.save();
 }
 setLesson(id) { this.current.lesson = id; this.save(); }
 // Starts a new conversation; the current one is kept if anything happened in it.
 startNew() {
  if (this.current.entries.length) this.past.unshift(this.current);
  this.past = this.past.slice(0, KEEP);
  this.current = fresh();
  this.save(true);
  return this.current;
 }
 // Reopens a past conversation; the current one takes its place in the history.
 open(id) {
  const i = this.past.findIndex(c => c.id === id);
  if (i < 0) return null;
  const [chosen] = this.past.splice(i, 1);
  if (this.current.entries.length) this.past.unshift(this.current);
  this.current = chosen;
  this.save(true);
  return chosen;
 }
 clearAll() { this.past = []; this.current = fresh(); this.save(true); return this.current; }
 get count() { return this.past.length + (this.current.entries.length ? 1 : 0); }
}

// How a conversation is listed: "5 Nov, 14:02 · What is a ii–V–I?"
export const describeConversation = c => `${new Date(c.started).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${c.title || `${c.entries.length} messages`}`;
