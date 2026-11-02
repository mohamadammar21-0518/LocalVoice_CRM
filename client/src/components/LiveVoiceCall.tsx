import { useEffect, useRef, useState } from "react";
import { Phone, PhoneOff, Mic, MicOff, Headphones } from "lucide-react";
import { trpc } from "@/lib/trpc";
import { Button } from "./ui/button";
import { openCallMicrophone, type CallUtterance } from "@/lib/callCapture";
import { speechChunks } from "@shared/speech";
import { callControl, type CallReply } from "@shared/voiceCall";
import type { CrmSource } from "@shared/voice";

type Line = { who: "You" | "Assistant"; text: string };
export default function LiveVoiceCall({ onBack, hubspot }: { onBack: () => void; hubspot: boolean }) {
  const utils = trpc.useUtils();
  const [active, setActive] = useState(false), [connecting, setConnecting] = useState(false);
  const [muted, setMuted] = useState(false), [status, setStatus] = useState("Ready to connect");
  const [language, setLanguage] = useState<"en" | "ms">("en");
  const [source, setSource] = useState<CrmSource | "salesforce">("local");
  const hubspotStatus = trpc.hubspot.status.useQuery(undefined, { retry: false });
  const salesforceStatus = trpc.salesforce.status.useQuery(undefined, { retry: false });
  const [lines, setLines] = useState<Line[]>([]), [partial, setPartial] = useState("");
  const [review, setReview] = useState<CallReply | null>(null), [error, setError] = useState("");
  const [seconds, setSeconds] = useState(0);
  const callId = useRef<string | null>(null);
  const life = useRef(0), utteranceNumber = useRef(0), reviewed = useRef<string | undefined>(undefined);
  const capture = useRef<Awaited<ReturnType<typeof openCallMicrophone>> | null>(null);
  const output = useRef<AudioContext | null>(null);
  const audio = useRef<{ source: AudioBufferSourceNode; finish: (played: boolean) => void } | null>(null);
  const synthesis = useRef<AbortController | null>(null), uploads = useRef<AbortController | null>(null);
  const utteranceContext = useRef<{ revision: number; reviewedId?: string }>({ revision: 0 });
  const queue = useRef<Promise<void>>(Promise.resolve()), queued = useRef(0);
  const log = (who: Line["who"], text: string) => setLines(value => [...value.slice(-39), { who, text }]);

  function interrupt() {
    synthesis.current?.abort(); synthesis.current = null;
    const playing = audio.current; audio.current = null;
    if (playing) { playing.source.onended = null; try { playing.source.stop(); } catch {} playing.finish(false); }
  }
  function hangUp() {
    life.current++; utteranceNumber.current++;
    capture.current?.close(); capture.current = null;
    uploads.current?.abort(); uploads.current = null;
    interrupt(); void output.current?.close().catch(() => {}); output.current = null;
    const id = callId.current; callId.current = null;
    if (id) void utils.client.voice.liveCall.end.mutate({ callId: id }).catch(() => {});
    reviewed.current = undefined; setReview(null); setPartial(""); setActive(false); setConnecting(false); setMuted(false); setStatus("Call ended");
  }
  const cleanup = useRef(hangUp); cleanup.current = hangUp;
  useEffect(() => () => cleanup.current(), []);
  useEffect(() => {
    if (!active) return;
    const started = Date.now();
    const timer = setInterval(() => setSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [active]);

  async function speak(reply: CallReply, generation: number, revision: number) {
    if (generation !== life.current || revision !== utteranceNumber.current) return;
    interrupt(); reviewed.current = undefined;
    const controller = new AbortController(); synthesis.current = controller;
    const valid = () => !controller.signal.aborted && generation === life.current && revision === utteranceNumber.current;
    setStatus("Assistant speaking · microphone is listening");
    try {
      const chunks = speechChunks(reply.text, 230);
      const fetchChunk = async (text: string) => {
        const result = await fetch("/api/voice/tts", { method: "POST", signal: controller.signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, language }) });
        if (!result.ok) throw new Error("Voice playback unavailable. Your call transcript is still visible.");
        return result.arrayBuffer();
      };
      let next = chunks.length ? fetchChunk(chunks[0]) : null;
      for (let index = 0; index < chunks.length; index++) {
        const bytes = await next!;
        if (!valid() || !output.current) return;
        next = index + 1 < chunks.length ? fetchChunk(chunks[index + 1]) : null;
        void next?.catch(() => {});
        const decoded = await output.current.decodeAudioData(bytes);
        if (!valid() || !output.current) return;
        await output.current.resume();
        if (!valid() || !output.current) return;
        const player = output.current.createBufferSource(); player.buffer = decoded; player.connect(output.current.destination);
        const completed = await new Promise<boolean>(resolve => {
          audio.current = { source: player, finish: resolve };
          player.onended = () => { audio.current = null; resolve(true); };
          player.start();
        });
        if (!completed || !valid()) return;
      }
      if (valid()) {
        reviewed.current = reply.reviewId;
        setStatus(reply.reviewId ? "Listening · say confirm change, cancel change, or a correction" : "Listening · ask your next question");
        if (reply.end) hangUp();
      }
    } catch (e) {
      if (valid()) { setError((e as Error).message); setStatus("Listening · say repeat to retry playback"); }
    }
  }

  function acceptUtterance(pending: Promise<CallUtterance>, generation: number) {
    const info = { ...utteranceContext.current };
    if (++queued.current > 4) {
      queued.current--; setError("The call is catching up. Please pause and repeat your latest request after the response.");
      void pending.then(segment => { if (segment.live) return fetch(`/api/voice/live/${segment.live.id}`, { method: "DELETE" }); }).catch(() => {});
      return;
    }
    queue.current = queue.current.then(async () => {
      try {
        const segment = await pending;
        const id = callId.current;
        if (generation !== life.current || !id) return;
        if (info.revision === utteranceNumber.current) setStatus("Understanding · microphone is listening");
        const response = await fetch("/api/voice/transcribe", {
          method: "POST", signal: uploads.current!.signal,
          headers: { "Content-Type": "audio/wav", "X-Audio-Filename": "call.wav", "X-Audio-Language": language,
            ...(segment.live ? { "X-Live-Id": segment.live.id, "X-Live-Count": String(segment.live.count) } : {}) }, body: segment.audio,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error ?? "I couldn't hear that. Please repeat your request.");
        if (generation !== life.current || !callId.current) return;
        const text = String(data.transcript ?? "").trim();
        if (!text) return;
        log("You", text); if (info.revision === utteranceNumber.current) setPartial("");
        // Low-confidence recognition can trigger a repeat, never an approval.
        const uncertainApproval = ["confirm", "confirmDelete"].includes(callControl(text) ?? "") && typeof data.confidence === "number" && data.confidence < 0.8;
        const reply = await utils.client.voice.liveCall.turn.mutate({ callId: id, requestId: crypto.randomUUID(),
          text: uncertainApproval ? "repeat" : text, reviewedId: uncertainApproval ? undefined : info.reviewedId });
        if (generation !== life.current) return;
        setReview(reply.reviewId ? reply : null); log("Assistant", reply.text);
        if (reply.saved) void Promise.all([utils.dashboard.get.invalidate(), utils.contacts.list.invalidate(), utils.tasks.list.invalidate(), utils.interactions.list.invalidate()]);
        // Let later speech interrupt audio, but serialize CRM turns so none overlap.
        void speak(reply, generation, info.revision);
      } catch (e) {
        if (generation === life.current) { setError((e as Error).message); setStatus("Listening · please repeat or clarify"); }
      } finally { if (generation === life.current) queued.current--; }
    });
  }

  async function start() {
    if (connecting || active) return;
    const generation = ++life.current;
    setConnecting(true); setError(""); setLines([]); setSeconds(0); setStatus("Connecting your microphone…");
    queue.current = Promise.resolve(); queued.current = 0; uploads.current = new AbortController();
    try {
      const context = new AudioContext(); output.current = context; await context.resume();
      const session = await utils.client.voice.liveCall.start.mutate({ source, language, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kuala_Lumpur" });
      if (generation !== life.current) { void utils.client.voice.liveCall.end.mutate({ callId: session.id }).catch(() => {}); return; }
      callId.current = session.id;
      const microphone = await openCallMicrophone({ language,
        onStart() {
          if (generation !== life.current) return;
          const revision = ++utteranceNumber.current;
          utteranceContext.current = { revision, reviewedId: reviewed.current };
          reviewed.current = undefined; interrupt(); setPartial(""); setError(""); setStatus("Listening to you…");
        },
        onPartial(text) { if (generation === life.current) setPartial(text); },
        onUtterance(pending) { acceptUtterance(pending, generation); },
        onError(message) { if (generation === life.current) setError(message); },
      });
      if (generation !== life.current) { microphone.close(); return; }
      capture.current = microphone; setActive(true); setConnecting(false);
      log("Assistant", session.text); void speak(session, generation, utteranceNumber.current);
    } catch (e) { if (generation === life.current) { hangUp(); setError((e as Error).message || "Microphone permission is required."); } }
  }

  return <div className="content-stack">
    <div className="filter-row"><div><p className="eyebrow">Live call · optional</p><h2 className="view-title">Talk to your CRM</h2><p className="text-sm text-muted-foreground">One connection. Speak, ask follow-up questions, or interrupt an answer.</p></div><Button variant="outline" disabled={active || connecting} onClick={onBack}>Back to dictation</Button></div>
    <section className="surface-card rounded-2xl border p-6 space-y-5">
      <div className="flex flex-wrap gap-4">
        <label>Language <select className="ml-2 rounded border bg-background p-2" value={language} disabled={active || connecting} onChange={e => setLanguage(e.target.value as "en" | "ms")}><option value="en">English</option><option value="ms">Bahasa Melayu</option></select></label>
        <label>CRM for this call <select className="ml-2 rounded border bg-background p-2" value={source} disabled={active || connecting} onChange={e => setSource(e.target.value as typeof source)}><option value="local">Local CRM</option><option value="hubspot" disabled={!hubspotStatus.data?.connected}>HubSpot — live records{!hubspotStatus.data?.connected ? " (connect first)" : ""}</option><option value="salesforce" disabled={!salesforceStatus.data?.connected}>Salesforce — live records{!salesforceStatus.data?.connected ? " (connect first)" : ""}</option>{hubspot && <option value="both">Local + imported HubSpot contacts</option>}</select></label>
      </div>
      <div className="flex items-center gap-4"><div className="rounded-full bg-primary/10 p-5"><Headphones className="h-8 w-8 text-primary" /></div><div><p role="status" className="font-medium">{muted ? "Microphone muted" : status}</p><p className="text-sm text-muted-foreground">{active ? `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")} · microphone stays connected until you end the call` : "Your existing dictation and audio upload tools remain available."}</p></div></div>
      <div className="flex gap-3">{!active && !connecting ? <Button onClick={() => void start()}><Phone className="h-4 w-4" />Start call</Button> : <>
        <Button variant="destructive" onClick={hangUp}><PhoneOff className="h-4 w-4" />End call</Button>
        <Button variant="outline" disabled={connecting} onClick={() => { const value = !muted; setMuted(value); capture.current?.mute(value); if (value) { interrupt(); reviewed.current = undefined; setPartial(""); } }}>{muted ? <Mic /> : <MicOff />}{muted ? "Unmute" : "Mute"}</Button>
      </>}</div>
      <p className="text-sm text-muted-foreground">Use headphones for reliable interruption. Pause briefly to finish a request. Say “repeat”, “cancel change”, or “end call”. Approve only after the complete change has been read aloud: “confirm change”.</p>
      <p className="text-xs text-muted-foreground">Ask general questions during a call, or work with your CRM. General answers come from your local model and cannot verify live news, weather or prices. Local calls read contacts, notes and follow-ups and prepare local notes or follow-ups. Choose HubSpot or Salesforce for live CRM record reads, creates, edits and deletions, subject to account permissions. Changes require a spoken readback and confirmation; deletions require “confirm delete”. HubSpot deletion archives the record. Call recordings follow your existing recording storage settings.</p>
      {error && <p role="alert" className="rounded border border-amber-300 p-3 text-sm">{error}</p>}
      {review && <div className="rounded-lg border border-amber-300 bg-amber-50 p-4 text-sm text-slate-900"><strong>Waiting for your approval</strong><p>{review.text}</p></div>}
    </section>
    <section className="surface-card rounded-2xl border p-5 space-y-4" aria-label="Call transcript"><h3 className="font-semibold">Conversation</h3>
      {lines.length === 0 && <p className="text-muted-foreground">Try: “Find Maya Chen”, then “Read her open follow-ups”.</p>}
      {lines.map((line, index) => <div key={index} className={line.who === "You" ? "ml-8 rounded-lg bg-primary/10 p-3" : "mr-8 rounded-lg bg-muted p-3"}><p className="text-xs font-semibold mb-1">{line.who}</p><p className="text-sm whitespace-pre-wrap">{line.text}</p></div>)}
      {partial && <p className="text-sm italic text-muted-foreground">You: {partial}…</p>}
    </section>
  </div>;
}
