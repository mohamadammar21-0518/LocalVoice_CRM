import { useState, useRef, useCallback, useEffect } from "react";
import { trpc } from "@/lib/trpc";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Mic, Square, Volume2, VolumeX, Check, X, Sparkles, Radio, Activity, Clock } from "lucide-react";
import type { ReviewedProposal, ContactChoice, CrmSource, VoiceSource } from "@shared/voice";
import { speechChunks } from "@shared/speech";
import { startLiveTranscription, type LiveCapture, type LiveResult, type LiveTelemetry } from "@/lib/liveTranscription";
import { AdaptiveVad } from "@/lib/adaptiveVad";
import { VoiceContactPicker as ContactPicker } from "./VoiceContactPicker";
import SalesforceRecordStudio, { voiceOperation } from "./SalesforceRecordStudio";
import LiveVoiceCall from "./LiveVoiceCall";

type Phase = "idle" | "requestingMic" | "recording" | "transcribing" | "preparing" | "speaking" | "reviewing" | "confirming";
type Timings = { stt: number | null; intent: number | null; retrieval: number | null; playback: number | null; endToEnd: number | null };
type Event = { type: string; requestId?: string; ms?: number; text?: string; url?: string; message?: string; sessionId?: number | null; proposal?: ReviewedProposal | null; sources?: VoiceSource[]; choices?: ContactChoice[]; warnings?: string[]; llmMs?: number; retrievalMs?: number; synthesisMs?: number };
type Workflow = "assistant" | "salesforce";
type SalesforceContact = { Id: string; Name: string; Email: string | null; Account: { Name: string } | null };
type SalesforceTask = { Id: string; Subject: string; Status: string; Priority: string; ActivityDate: string | null };
const fmt = (ms: number | null) => ms === null ? "—" : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
const initialTimings: Timings = { stt: null, intent: null, retrieval: null, playback: null, endToEnd: null };
function salesforceContactName(prompt: string) {
  return prompt.trim()
    .replace(/^(?:please\s+)?(?:find|look\s+up|search\s+for|cari)\s+/i, "")
    .replace(/\s+(?:(?:and|then|dan)\s+)?(?:read|tell\s+me|list|show|baca|senaraikan)\b.*$/i, "")
    .replace(/\s+(?:open\s+)?(?:tasks?|follow.?ups?|tugasan)\b.*$/i, "")
    .replace(/[?.!]+$/, "")
    .trim();
}
function formatSalesforceDate(value: string | null, language: "en" | "ms") {
  if (!value) return language === "ms" ? "tiada tarikh akhir" : "no due date";
  const date = new Date(`${value}T00:00:00Z`);
  return new Intl.DateTimeFormat(language === "ms" ? "ms-MY" : "en-MY", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(date);
}
export default function VoiceWorkspace() {
  const [voiceMode, setVoiceMode] = useState<"dictation" | "call">("dictation");
  const [phase, setPhase] = useState<Phase>("idle");
  const [conversation, setConversation] = useState(false);
  const conversationRef = useRef(false);
  const [listenAgain, setListenAgain] = useState(false);
  const startNextTurn = useRef<() => void>(() => {});
  const [transcript, setTranscript] = useState("");
  const [response, setResponse] = useState("");
  const [sessionId, setSessionId] = useState<number | null>(null);
  const [proposal, setProposal] = useState<ReviewedProposal | null>(null);
  const [activeActions, setActiveActions] = useState<boolean[]>([]);
  const [sources, setSources] = useState<VoiceSource[]>([]);
  const [choices, setChoices] = useState<ContactChoice[]>([]);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [contextContact, setContextContact] = useState<ContactChoice | null>(null);
  const [source, setSource] = useState<CrmSource | "salesforce">("local");
  const [externalReview, setExternalReview] = useState<{ callId: string; reviewId: string; text: string; delete: boolean } | null>(null);
  const externalCallRef = useRef<string | null>(null);
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kuala_Lumpur");
  const [speechEnabled, setSpeechEnabled] = useState(true);
  const [prepareAfterRecording, setPrepareAfterRecording] = useState(true);
  const [autoStop, setAutoStop] = useState(true);
  const [livePreview, setLivePreview] = useState(true);
  // Instant uses the on-device Vosk stream and returns as soon as the microphone
  // stops. Accurate sends the completed recording through Whisper instead; that
  // is the path a personal Whisper adapter improves.
  const [transcriptionMode, setTranscriptionMode] = useState<"instant" | "accurate">("instant");
  const [dictationReady, setDictationReady] = useState(false);
  const liveStopRef = useRef<LiveCapture | null>(null);
  const [language, setLanguage] = useState("en");
  const [responseLanguage, setResponseLanguage] = useState<"en" | "ms">("en");
  const [workflow, setWorkflow] = useState<Workflow>("assistant");
  const [salesforceContacts, setSalesforceContacts] = useState<SalesforceContact[]>([]);
  const [salesforceContact, setSalesforceContact] = useState<SalesforceContact | null>(null);
  const [salesforceTasks, setSalesforceTasks] = useState<SalesforceTask[]>([]);
  const [salesforceMessage, setSalesforceMessage] = useState("");
  const [seconds, setSeconds] = useState(0);
  const [timings, setTimings] = useState<Timings>(initialTimings);
  const [sttDetails, setSttDetails] = useState<{ convert: number; queueWait: number; inference: number } | null>(null);
  const [transcriptionQuality, setTranscriptionQuality] = useState<{ confidence: number | null; vocabularyMatch: string | null } | null>(null);
  const [playbackBlocked, setPlaybackBlocked] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const utils = trpc.useUtils();
  const integration = trpc.integrations.hubspotStatus.useQuery();
  const hubspotStatus = trpc.hubspot.status.useQuery(undefined, { retry: false });
  const salesforceStatus = trpc.salesforce.status.useQuery(undefined, { retry: false });
  const metricSummary = trpc.voice.metrics.useQuery({ days: 7 }, { enabled: showMetrics });
  const history = trpc.voice.history.useQuery({ limit: 25 }, { enabled: showHistory });
  const playbackMetric = trpc.voice.playbackMetric.useMutation({ onError: () => {} });
  const latencySamples = trpc.voice.latencySamples.useMutation({ onSuccess: () => { void utils.voice.metrics.invalidate(); }, onError: () => {} });
  const salesforceTimingMetric = trpc.salesforce.timingMetric.useMutation({ onSuccess: () => { void utils.voice.metrics.invalidate(); }, onError: () => {} });

  const controllerRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const requestingMic = useRef(false);
  const micRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const analyserRef = useRef<AudioContext | null>(null);
  const queueRef = useRef<Promise<Blob>[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlRef = useRef<string | null>(null);
  const playingRef = useRef(false);
  const networkDone = useRef(true);
  const proposalRef = useRef<ReviewedProposal | null>(null);
  const requestIdRef = useRef<string | null>(null);
  const transcribedRequestRef = useRef<{ requestId: string; startedAt: number } | null>(null);
  const turnStarted = useRef(0);
  const speechEnded = useRef<number | null>(null);
  const firstPlayed = useRef(false);
  const firstTtsReady = useRef(false);
  const discardRecording = useRef(false);
  const sourceInitialized = useRef(false);
  const retrievalStartedRef = useRef<number | null>(null);
  const endpointDelayRef = useRef<number | null>(null);
  const playNextRef = useRef<() => void>(() => {});

  useEffect(() => { sourceInitialized.current = true; }, []);

  const endExternal = useCallback(() => {
    const id = externalCallRef.current;
    externalCallRef.current = null;
    setExternalReview(null);
    if (id) void utils.client.voice.liveCall.end.mutate({ callId: id }).catch(() => {});
  }, [utils]);
  useEffect(() => () => { const id = externalCallRef.current; if (id) void utils.client.voice.liveCall.end.mutate({ callId: id }).catch(() => {}); }, [utils]);

  const stopResponse = useCallback(() => {
    generation.current++;
    controllerRef.current?.abort(); controllerRef.current = null;
    liveStopRef.current?.cancel(); liveStopRef.current = null;
    queueRef.current = []; networkDone.current = true; playingRef.current = false;
    if (audioRef.current) { audioRef.current.onended = null; audioRef.current.onerror = null; audioRef.current.onplaying = null; audioRef.current.pause(); audioRef.current.src = ""; audioRef.current = null; }
    if (audioUrlRef.current) { URL.revokeObjectURL(audioUrlRef.current); audioUrlRef.current = null; }
    setPlaybackBlocked(false);
  }, []);

  const finishPlayback = () => {
    if (!playingRef.current && !queueRef.current.length && networkDone.current) {
      setPhase(proposalRef.current ? "reviewing" : "idle");
      if (conversationRef.current && !proposalRef.current) setListenAgain(true);
    }
  };
  const playNext = async () => {
    if (playingRef.current || !queueRef.current.length) { finishPlayback(); return; }
    const currentGeneration = generation.current;
    playingRef.current = true;
    const pending = queueRef.current.shift()!;
    try {
      const blob = await pending;
      if (currentGeneration !== generation.current) return;
      const url = URL.createObjectURL(blob);
      audioUrlRef.current = url;
      const audio = new Audio(url); audioRef.current = audio;
      const complete = () => {
        URL.revokeObjectURL(url);
        if (currentGeneration !== generation.current) return;
        audioRef.current = null; audioUrlRef.current = null; playingRef.current = false;
        playNextRef.current();
      };
      audio.onended = complete;
      audio.onerror = () => { conversationRef.current = false; setConversation(false); setListenAgain(false); toast.error("Audio playback failed. The text response is available."); complete(); };
      audio.onplaying = () => {
        if (currentGeneration !== generation.current) return;
        setPlaybackBlocked(false); setPhase("speaking");
        if (!firstPlayed.current) {
          firstPlayed.current = true;
          const playback = Math.round(performance.now() - turnStarted.current);
          const speechToFirstPlayback = speechEnded.current === null ? null : Math.round(performance.now() - speechEnded.current);
          setTimings(value => ({ ...value, playback, endToEnd: speechToFirstPlayback }));
          if (requestIdRef.current) playbackMetric.mutate({ requestId: requestIdRef.current, durationMs: playback });
          if (requestIdRef.current) latencySamples.mutate({ requestId: requestIdRef.current, language: responseLanguage, engine: "browser-audio", samples: [
            { metric: "first_playback", durationMs: playback },
            ...(speechToFirstPlayback === null ? [] : [{ metric: "speech_to_first_playback" as const, durationMs: speechToFirstPlayback }]),
          ] });
          if (workflow === "salesforce" && requestIdRef.current) salesforceTimingMetric.mutate({ requestId: requestIdRef.current, stage: "first_audio", durationMs: playback });
        }
      };
      try { await audio.play(); }
      catch { if (currentGeneration === generation.current) { setPlaybackBlocked(true); setPhase(proposalRef.current ? "reviewing" : "idle"); } }
    } catch {
      if (currentGeneration === generation.current) { playingRef.current = false; toast.error("Speech audio is unavailable. Read the text response."); playNextRef.current(); }
    }
  };
  playNextRef.current = () => { void playNext(); };

  const prepare = async (prompt: string, sid = sessionId, selectedId = contextContact?.id ?? null) => {
    if (!prompt.trim()) return;
    stopResponse();
    const currentGeneration = generation.current;
    const controller = new AbortController(); controllerRef.current = controller;
    setPhase("preparing"); setResponse(""); setSources([]); setWarnings([]); setChoices([]);
    setProposal(null); proposalRef.current = null;
    requestIdRef.current = null; firstPlayed.current = false; firstTtsReady.current = false; networkDone.current = false;
    turnStarted.current = performance.now();
    setTimings(value => ({ ...value, intent: null, retrieval: null, playback: null, endToEnd: null }));
    try {
      const result = await fetch("/api/voice/respond", { method: "POST", credentials: "same-origin", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt, sessionId: sid, source, timezone, contactId: selectedId, speak: speechEnabled, responseLanguage }) });
      if (!result.ok) { const body = await result.json(); throw new Error(body.error ?? "Voice request failed"); }
      if (!result.body) throw new Error("Streaming response unavailable");
      const reader = result.body.getReader(), decoder = new TextDecoder();
      let buffer = "";
      const handleEvent = (line: string) => {
        if (!line.startsWith("data: ") || currentGeneration !== generation.current) return;
        const event = JSON.parse(line.slice(6)) as Event;
        if (event.type === "start") requestIdRef.current = event.requestId ?? null;
        if (event.type === "response") {
          setResponse(event.text ?? ""); setSources(event.sources ?? []); setChoices(event.choices ?? []); setWarnings(event.warnings ?? []);
          setSessionId(event.sessionId ?? null); setProposal(event.proposal ?? null); proposalRef.current = event.proposal ?? null;
          setActiveActions(event.proposal?.actions.map(() => true) ?? []);
          if (conversationRef.current && event.choices?.length === 1 && !event.proposal) setContextContact(event.choices[0]);
          setTimings(value => ({ ...value, intent: event.llmMs ?? null, retrieval: event.retrievalMs ?? null }));
        }
        if (event.type === "audio" && event.url) {
          if (!firstTtsReady.current && requestIdRef.current && event.synthesisMs !== undefined) {
            firstTtsReady.current = true;
            latencySamples.mutate({ requestId: requestIdRef.current, language: responseLanguage, engine: "piper", samples: [{ metric: "tts_ready", durationMs: Math.round(event.synthesisMs) }] });
          }
          // Fetch upcoming audio while the previous sentence is playing.
          const pending = fetch(event.url, { credentials: "same-origin", signal: controller.signal }).then(async audio => { if (!audio.ok) throw new Error("Audio unavailable"); return audio.blob(); });
          void pending.catch(() => {});
          queueRef.current.push(pending); playNextRef.current();
        }
        if (event.type === "warning") { conversationRef.current = false; setConversation(false); setListenAgain(false); setWarnings(value => [...value, event.message ?? "Speech is unavailable"]); }
        if (event.type === "error") throw new Error(event.message ?? "Request failed");
        if (event.type === "done") { networkDone.current = true; finishPlayback(); void utils.voice.history.invalidate(); void utils.voice.metrics.invalidate(); }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) { handleEvent(buffer.slice(0, newline).replace(/\r$/, "")); buffer = buffer.slice(newline + 1); }
      }
      if (!networkDone.current && currentGeneration === generation.current) throw new Error("Response interrupted. Retry the request.");
    } catch (error) {
      if (currentGeneration === generation.current && !controller.signal.aborted) {
        conversationRef.current = false; setConversation(false); setListenAgain(false);
        networkDone.current = true; controller.abort(); queueRef.current = [];
        toast.error(error instanceof Error ? error.message : "Request failed");
        finishPlayback();
      }
    }
  };

  const speakReceipt = async (text: string, options?: { startedAt?: number; requestId?: string | null }) => {
    stopResponse(); setResponse(text);
    if (!speechEnabled) { setPhase("idle"); return; }
    const controller = new AbortController(); controllerRef.current = controller;
    const currentGeneration = generation.current;
    networkDone.current = false; setPhase("preparing"); turnStarted.current = options?.startedAt ?? performance.now(); firstPlayed.current = false; firstTtsReady.current = false; requestIdRef.current = options?.requestId ?? null;
    try {
      const firstBreak = text.length > 90 ? Math.max(40, text.slice(0, 91).search(/[,;:!?\.](?=\s)/) + 1 || text.slice(0, 91).lastIndexOf(" ")) : text.length;
      const chunks = text.length > 90 ? [text.slice(0, firstBreak).trim(), ...speechChunks(text.slice(firstBreak).trim(), 180)] : [text.trim()];
      for (const chunk of chunks.filter(Boolean)) {
        const ttsStarted = performance.now();
        const result = await fetch("/api/voice/tts", { method: "POST", signal: controller.signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: chunk, language: responseLanguage }) });
        if (!result.ok) throw new Error("Speech unavailable. The text response is available.");
        const audio = await result.blob();
        if (currentGeneration !== generation.current) return;
        if (!firstTtsReady.current && requestIdRef.current) {
          firstTtsReady.current = true;
          latencySamples.mutate({ requestId: requestIdRef.current, language: responseLanguage, engine: "piper", samples: [{ metric: "tts_ready", durationMs: Math.round(performance.now() - ttsStarted) }] });
        }
        queueRef.current.push(Promise.resolve(audio)); playNextRef.current();
      }
    } catch (error) {
      if (currentGeneration === generation.current && !controller.signal.aborted) toast.error(error instanceof Error ? error.message : "Speech unavailable");
    } finally {
      if (currentGeneration === generation.current) { networkDone.current = true; finishPlayback(); }
    }
  };
  const prepareExternal = async (prompt: string) => {
    if (source !== "salesforce" && source !== "hubspot") return;
    stopResponse();
    const currentGeneration = generation.current;
    setPhase("preparing"); setResponse(""); setSources([]); setWarnings([]); setChoices([]);
    try {
      let callId = externalCallRef.current;
      if (!callId) {
        const started = await utils.client.voice.liveCall.start.mutate({ source, language: responseLanguage, timezone });
        if (currentGeneration !== generation.current) { void utils.client.voice.liveCall.end.mutate({ callId: started.id }).catch(() => {}); return; }
        callId = started.id;
        externalCallRef.current = callId;
      }
      const result = await utils.client.voice.liveCall.turn.mutate({ callId, requestId: crypto.randomUUID(), text: prompt });
      if (currentGeneration !== generation.current) return;
      setExternalReview(result.reviewId ? { callId, reviewId: result.reviewId, text: result.text, delete: /confirm delete/i.test(result.text) } : null);
      setResponse(result.text); setPhase(result.reviewId ? "reviewing" : "idle");
      if (speechEnabled) void speakReceipt(result.text);
    } catch (error) {
      if (currentGeneration !== generation.current) return;
      const message = error instanceof Error ? error.message : "CRM request failed";
      setResponse(message); setPhase("idle"); toast.error(message);
      endExternal();
    }
  };
  const decideExternal = async (approve: boolean) => {
    const review = externalReview;
    if (!review || source !== "salesforce" && source !== "hubspot") return;
    setPhase("confirming");
    try {
      const result = await utils.client.voice.liveCall.turn.mutate({ callId: review.callId, requestId: crypto.randomUUID(), text: approve ? review.delete ? "confirm delete" : "confirm change" : "cancel change", ...(approve ? { reviewedId: review.reviewId } : {}) });
      setExternalReview(null); setResponse(result.text); setPhase("idle");
      if (result.saved) { void utils.hubspot.invalidate(); void utils.salesforce.invalidate(); toast.success("CRM change saved"); }
      if (speechEnabled) void speakReceipt(result.text);
    } catch (error) { setPhase("reviewing"); toast.error(error instanceof Error ? error.message : "Could not complete CRM review"); }
  };
  const loadSalesforceTasks = async (contact: SalesforceContact, startedAt: number, requestId: string) => {
    setPhase("preparing");
    const currentGeneration = generation.current;
    const retrievalStart = retrievalStartedRef.current ?? performance.now();
    setSalesforceContact(contact); setSalesforceContacts([]); setSalesforceTasks([]); setSalesforceMessage("Reading open tasks from Salesforce…");
    try {
      const result = await utils.salesforce.openTasks.fetch({ contactId: contact.Id });
      if (currentGeneration !== generation.current) return;
      const retrievalMs = Math.round(performance.now() - retrievalStart);
      setSalesforceTasks(result.tasks as SalesforceTask[]);
      setSalesforceMessage(result.tasks.length ? "" : (responseLanguage === "ms" ? "Tiada tugasan terbuka ditemui untuk kenalan ini." : "No open tasks were found for this contact."));
      setTimings(value => ({ ...value, retrieval: retrievalMs }));
      salesforceTimingMetric.mutate({ requestId, stage: "retrieval", durationMs: retrievalMs });
      setWarnings(result.truncated ? ["Salesforce returned the first 100 open tasks. More tasks may exist."] : []);
      const taskLines = result.tasks.slice(0, 5).map(task => task.Subject + ", " + (responseLanguage === "ms" ? "tarikh akhir " : "due ") + formatSalesforceDate(task.ActivityDate, responseLanguage) + ".");
      const count = `${result.truncated ? (responseLanguage === "ms" ? "sekurang-kurangnya " : "at least ") : ""}${result.tasks.length}`;
      const spokenText = responseLanguage === "ms"
        ? result.tasks.length ? "Kenalan ditemui: " + contact.Name + ". Terdapat " + count + " tugasan terbuka. " + taskLines.join(" ") : "Kenalan ditemui: " + contact.Name + ". Tiada tugasan terbuka."
        : result.tasks.length ? "Found " + contact.Name + ". " + (result.tasks.length === 1 ? "They have 1 open task: " : "They have " + count + " open tasks: ") + taskLines.join(" ")
          : "Found " + contact.Name + ". They have no open tasks.";
      const summary = spokenText + (result.tasks.length > 5 ? (responseLanguage === "ms" ? " Saya membacakan lima tugasan pertama. Lihat senarai di skrin untuk tugasan lain." : " I read the first five tasks. See the list on screen for the rest.") : "");
      void speakReceipt(summary, { startedAt, requestId });
    } catch (error) {
      if (currentGeneration !== generation.current) return;
      const message = error instanceof Error ? error.message : "Salesforce task lookup failed";
      setSalesforceMessage(message); toast.error(message);
      const retrievalMs = Math.round(performance.now() - retrievalStart);
      setTimings(value => ({ ...value, retrieval: retrievalMs }));
      salesforceTimingMetric.mutate({ requestId, stage: "retrieval", outcome: "error", durationMs: retrievalMs });
      setPhase("idle");
    }
  };
  const lookupSalesforce = async (prompt: string, requestId: string = crypto.randomUUID(), turnStart?: number) => {
    const intentStarted = performance.now();
    const name = salesforceContactName(prompt);
    if (!name || name.length > 100) { toast.error("Say a contact name, for example: Find Maya Chen and read her open tasks."); return; }
    if (!salesforceStatus.data?.connected) { toast.error("Connect Salesforce on the Salesforce tab first."); return; }
    stopResponse();
    const currentGeneration = generation.current;
    const startedAt = turnStart ?? performance.now(); turnStarted.current = startedAt; requestIdRef.current = requestId;
    const intentMs = Math.max(0, Math.round(performance.now() - intentStarted));
    retrievalStartedRef.current = performance.now();
    setPhase("preparing"); setResponse(""); setSources([]); setChoices([]); setWarnings([]); setProposal(null); proposalRef.current = null;
    setSalesforceContact(null); setSalesforceContacts([]); setSalesforceTasks([]); setSalesforceMessage("Searching Salesforce contacts…");
    setTimings(value => ({ ...value, stt: turnStart !== undefined ? value.stt : null, intent: intentMs, retrieval: null, playback: null, endToEnd: null }));
    salesforceTimingMetric.mutate({ requestId, stage: "intent", durationMs: intentMs });
    try {
      const result = await utils.salesforce.findContact.fetch({ request: name });
      if (currentGeneration !== generation.current) return;
      if (!result.contacts.length) {
        const retrievalMs = Math.round(performance.now() - retrievalStartedRef.current!);
        const notFound = responseLanguage === "ms" ? "Tiada kenalan Salesforce ditemui dengan nama tersebut." : "I couldn't find a Salesforce contact with that name.";
        setSalesforceMessage(notFound); setResponse(notFound);
        setTimings(value => ({ ...value, retrieval: retrievalMs }));
        salesforceTimingMetric.mutate({ requestId, stage: "retrieval", durationMs: retrievalMs });
        void speakReceipt(notFound, { startedAt, requestId }); return;
      }
      if (result.contacts.length > 1) {
        setSalesforceContacts(result.contacts as SalesforceContact[]); setSalesforceMessage(result.truncated ? "Showing the first 20 matches. Refine the name or choose the correct contact." : "Choose the right contact to read their open tasks.");
        retrievalStartedRef.current = null;
        setPhase("idle"); return;
      }
      await loadSalesforceTasks(result.contacts[0] as SalesforceContact, startedAt, requestId);
    } catch (error) {
      if (currentGeneration !== generation.current) return;
      const message = error instanceof Error ? error.message : "Salesforce contact lookup failed";
      setSalesforceMessage(message); toast.error(message); setPhase("idle");
      const retrievalMs = Math.round(performance.now() - retrievalStartedRef.current!);
      setTimings(value => ({ ...value, retrieval: retrievalMs }));
      salesforceTimingMetric.mutate({ requestId, stage: "retrieval", outcome: "error", durationMs: retrievalMs });
    }
  };
  const confirm = trpc.voice.confirm.useMutation({
    onSuccess: result => {
      setProposal(null); proposalRef.current = null; setSessionId(null); setPhase("idle");
      toast.success(result.replayed ? "This batch was already saved" : "CRM changes saved");
      void Promise.all([utils.dashboard.get.invalidate(), utils.contacts.list.invalidate(), utils.tasks.list.invalidate(), utils.interactions.list.invalidate(), utils.voice.history.invalidate(), utils.voice.metrics.invalidate()]);
      const receipt = responseLanguage === "ms" ? result.actions.map(action => `${action.type === "add_note" ? "Nota disimpan untuk" : action.type === "create_follow_up" ? "Susulan dibuat untuk" : "Kenalan ditemui:"} ${action.contact.firstName} ${action.contact.lastName}.`).join(" ") : result.receipt;
      void speakReceipt(receipt);
    },
    onError: error => { toast.error(error.message); setPhase("reviewing"); },
  });
  const reject = trpc.voice.reject.useMutation({
    onSuccess: () => { stopResponse(); setProposal(null); proposalRef.current = null; setSessionId(null); setPhase("idle"); setResponse("The proposed changes were discarded."); void utils.voice.history.invalidate(); },
    onError: error => toast.error(error.message),
  });
  const releaseMic = () => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    micRef.current?.getTracks().forEach(track => track.stop()); micRef.current = null;
    void analyserRef.current?.close().catch(() => {}); analyserRef.current = null;
  };
  const stopRecording = () => {
    if (recorderRef.current?.state === "recording") { speechEnded.current = performance.now(); recorderRef.current.stop(); }
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
  };
  const uploadAudio = async (blob: Blob, filename: string, live?: LiveResult, liveTelemetry?: LiveTelemetry) => {
    stopResponse();
    const currentGeneration = generation.current;
    const controller = new AbortController(); controllerRef.current = controller;
    setPhase("transcribing");
    setProposal(null); proposalRef.current = null; setSessionId(null); setTimings(initialTimings);
    const start = speechEnded.current ?? performance.now(); turnStarted.current = start; setSttDetails(null); setTranscriptionQuality(null);
    try {
      if (!blob.size || blob.size > 16 * 1024 * 1024) throw new Error("Audio must be smaller than 16 MB");
      const result = await fetch("/api/voice/transcribe", { method: "POST", credentials: "same-origin", signal: controller.signal, headers: { "Content-Type": blob.type || "audio/webm", "X-Audio-Filename": encodeURIComponent(filename), ...(live ? { "X-Live-Id": live.id, "X-Live-Count": String(live.count) } : {}), ...(language ? { "X-Audio-Language": language } : {}) }, body: blob });
      const data = await result.json();
      if (!result.ok) throw new Error(data.error ?? "Transcription failed");
      if (currentGeneration !== generation.current) return;
      setTranscript(data.transcript); setSessionId(data.sessionId);
      setSttDetails(data.timing ?? null);
      setTranscriptionQuality({ confidence: typeof data.confidence === "number" ? data.confidence : null, vocabularyMatch: data.vocabularyMatch ?? null });
      requestIdRef.current = data.requestId ?? null;
      transcribedRequestRef.current = data.requestId ? { requestId: data.requestId, startedAt: start } : null;
      const speechToTextReady = Math.round(performance.now() - start);
      setTimings(value => ({ ...value, stt: speechToTextReady })); setPhase("idle");
      if (data.requestId) latencySamples.mutate({
        requestId: data.requestId, language: liveTelemetry?.language ?? language,
        engine: liveTelemetry?.engine ?? "full-recording",
        samples: [...(liveTelemetry?.samples ?? []), { metric: "speech_to_text_ready" as const, durationMs: speechToTextReady }].slice(-64),
      });
      if (prepareAfterRecording || conversationRef.current) {
        if (source === "salesforce" || source === "hubspot") void prepareExternal(data.transcript);
        else void prepare(data.transcript, data.sessionId);
      }
    } catch (error) { if (currentGeneration === generation.current && !controller.signal.aborted) { setListenAgain(false); toast.error(error instanceof Error ? error.message : "Transcription failed"); setPhase("idle"); } }
  };
  const startRecording = async () => {
    if (requestingMic.current || recorderRef.current) return;
    setExternalReview(null);
    setListenAgain(false);
    requestingMic.current = true;
    const interruptedRequestId = (phase === "speaking" || phase === "preparing") ? requestIdRef.current : null;
    const bargeInStarted = interruptedRequestId ? performance.now() : null;
    stopResponse(); setDictationReady(false); setProposal(null); proposalRef.current = null; setSessionId(null); setResponse("");
    const currentGeneration = generation.current;
    setPhase("requestingMic");
    transcribedRequestRef.current = null;
    discardRecording.current = false; speechEnded.current = null; endpointDelayRef.current = null;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (currentGeneration !== generation.current) { stream.getTracks().forEach(track => track.stop()); return; }
      micRef.current = stream;
      if (interruptedRequestId && bargeInStarted !== null) latencySamples.mutate({ requestId: interruptedRequestId, language, engine: "browser-mic", samples: [{ metric: "barge_in_ready", durationMs: Math.round(performance.now() - bargeInStarted) }] });
      const mime = ["audio/ogg;codecs=opus", "audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find(value => MediaRecorder.isTypeSupported(value));
      const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined); recorderRef.current = recorder; chunksRef.current = [];
      recorder.ondataavailable = event => { if (event.data.size) chunksRef.current.push(event.data); };
      recorder.onstop = async () => {
        const capture = liveStopRef.current;
        const finishing = capture?.finish();
        releaseMic(); recorderRef.current = null;
        if (currentGeneration !== generation.current) return;
        if (discardRecording.current) { capture?.cancel(); setPhase("idle"); return; }
        setPhase("transcribing");
        const blob = new Blob(chunksRef.current, { type: recorder.mimeType });
        const extension = recorder.mimeType.includes("ogg") ? "ogg" : recorder.mimeType.includes("mp4") ? "m4a" : "webm";
        const live = await finishing;
        const telemetry = capture?.telemetry() ?? { language, engine: "media-recorder", samples: [] };
        if (endpointDelayRef.current !== null) telemetry.samples.push({ metric: "endpoint_detection", durationMs: endpointDelayRef.current });
        if (currentGeneration !== generation.current) return;
        if (liveStopRef.current === capture) liveStopRef.current = null;
        void uploadAudio(blob, `voice.${extension}`, live, telemetry);
      };
      recorder.onerror = () => {
        recorder.onstop = null;
        if (recorder.state !== "inactive") recorder.stop();
        liveStopRef.current?.cancel(); liveStopRef.current = null;
        releaseMic(); recorderRef.current = null;
        if (currentGeneration === generation.current) { setPhase("idle"); toast.error("Recording failed. Please try again."); }
      };
      if (livePreview && transcriptionMode === "instant") {
        await startLiveTranscription(stream, language,
          text => { if (currentGeneration === generation.current && recorder.state === "recording") setTranscript(text); },
          () => { if (currentGeneration === generation.current) { setDictationReady(false); setWarnings(["Live dictation stopped. Your recording will be transcribed after Stop."]); } }
        ).then(capture => {
          if (currentGeneration !== generation.current) capture.cancel();
          else { liveStopRef.current = capture; setDictationReady(true); }
        }).catch(() => { if (currentGeneration === generation.current) setWarnings(["Live dictation could not start. Your recording will be transcribed after Stop."]); });
      }
      if (currentGeneration !== generation.current) { releaseMic(); recorderRef.current = null; return; }
      recorder.start(250); setSeconds(0); setPhase("recording"); setTranscript("");
      let elapsed = 0;
      let analyser: AnalyserNode | null = null;
      let vad: AdaptiveVad | null = null;
      if (autoStop || conversationRef.current) {
        try {
          const context = new AudioContext(); analyserRef.current = context;
          await context.resume();
          analyser = context.createAnalyser(); analyser.fftSize = 1024; analyser.smoothingTimeConstant = 0;
          context.createMediaStreamSource(stream).connect(analyser);
          vad = new AdaptiveVad(performance.now(), language === "ms" ? 900 : 700);
        } catch { analyser = null; setWarnings(["Automatic pause detection is unavailable. Stop recording manually."]); }
      }
      const samples = new Float32Array(1024);
      timerRef.current = setInterval(() => {
        elapsed += 0.05; setSeconds(Math.floor(elapsed));
        if (analyser && vad) {
          analyser.getFloatTimeDomainData(samples);
          let energy = 0; for (const sample of samples) energy += sample * sample;
          const update = vad.update(Math.sqrt(energy / samples.length), performance.now());
          if (update.shouldStop) { endpointDelayRef.current = Math.round(update.endpointMs ?? 0); stopRecording(); }
        }
        if (elapsed >= 120 || chunksRef.current.reduce((sum, blob) => sum + blob.size, 0) >= 15 * 1024 * 1024) stopRecording();
      }, 50);
    } catch { if (currentGeneration === generation.current) { conversationRef.current = false; setConversation(false); setListenAgain(false); releaseMic(); setPhase("idle"); toast.error("Microphone access is unavailable. Check browser permission and use HTTPS or localhost."); } }
    finally { requestingMic.current = false; }
  };

  startNextTurn.current = () => { void startRecording(); };
  useEffect(() => {
    if (!conversation || !listenAgain || phase !== "idle" || playbackBlocked || proposal) return;
    // Leave a short gap after speaker playback before reopening the microphone.
    const timer = setTimeout(() => {
      setListenAgain(false);
      if (conversationRef.current) startNextTurn.current();
    }, 450);
    return () => clearTimeout(timer);
  }, [conversation, listenAgain, phase, playbackBlocked, proposal]);

  const endConversation = () => {
    conversationRef.current = false; setConversation(false); setListenAgain(false);
    discardRecording.current = true;
    stopResponse();
    if (recorderRef.current) {
      recorderRef.current.onstop = null;
      if (recorderRef.current.state !== "inactive") recorderRef.current.stop();
      recorderRef.current = null;
    }
    releaseMic();
    setPhase(proposalRef.current ? "reviewing" : "idle");
  };

  useEffect(() => {
    setContextContact(null);
    if (conversationRef.current) endConversation();
  }, [source, workflow]);

  useEffect(() => () => {
    conversationRef.current = false;
    generation.current++; controllerRef.current?.abort(); liveStopRef.current?.cancel();
    audioRef.current?.pause(); if (audioUrlRef.current) URL.revokeObjectURL(audioUrlRef.current);
    if (timerRef.current) clearInterval(timerRef.current);
    if (recorderRef.current) { recorderRef.current.onstop = null; if (recorderRef.current.state === "recording") recorderRef.current.stop(); }
    micRef.current?.getTracks().forEach(track => track.stop()); void analyserRef.current?.close().catch(() => {});
  }, []);
  const updateAction = (index: number, values: Partial<ReviewedProposal["actions"][number]>) => {
    if (!proposal) return;
    const next = { ...proposal, actions: proposal.actions.map((action, at) => at === index ? { ...action, ...values } : action) } as ReviewedProposal;
    setProposal(next); proposalRef.current = next;
  };
  const busy = ["requestingMic", "transcribing", "preparing", "confirming"].includes(phase);
  const selected = proposal?.actions.filter((_, index) => activeActions[index]) ?? [];
  const canConfirm = !!selected.length && selected.every(action => action.type !== "unsupported" && (action.type === "blueprint_action" || (action.contactId && (action.type !== "add_note" || action.note?.trim()) && (action.type !== "create_follow_up" || action.taskTitle?.trim() && /^\d{4}-\d{2}-\d{2}$/.test(action.dueDate ?? "")))));

  if (voiceMode === "call") return <LiveVoiceCall hubspot={!!integration.data?.configured} onBack={() => setVoiceMode("dictation")} />;
  return <div className="content-stack">
    <Card className="surface-card"><CardContent className="pt-5 flex flex-wrap items-center gap-3">
      <div className="flex-1"><h3 className="font-semibold">Dictation or a live call</h3><p className="text-sm text-muted-foreground">Keep recording and transcribing here, or start a hands-free call with spoken replies and approvals.</p></div>
      <Button disabled={busy || phase === "recording" || !!proposal} onClick={() => { endConversation(); setVoiceMode("call"); }}>Open live call</Button>
    </CardContent></Card>
    <div className="filter-row"><div><p className="eyebrow">Voice CRM</p><h2 className="view-title">Speak. Review. Save.</h2><p className="text-sm text-muted-foreground mt-1">Answers use your CRM records. Changes wait for your confirmation.</p></div>
      <Button variant="ghost" disabled={phase === "recording" || phase === "requestingMic"} onClick={() => { setSpeechEnabled(!speechEnabled); if (speechEnabled) { stopResponse(); setPhase(proposalRef.current ? "reviewing" : "idle"); } }}>{speechEnabled ? <Volume2 /> : <VolumeX />}{speechEnabled ? "Voice on" : "Voice off"}</Button></div>
    <div className="flex flex-wrap gap-3 items-center">
      <label className="text-sm">CRM <select aria-label="CRM data source" className="ml-2 rounded border p-2 bg-background" value={source} disabled={busy || phase === "recording"} onChange={event => { stopResponse(); endExternal(); setSource(event.target.value as typeof source); setResponse(""); setPhase("idle"); }}><option value="local">Local CRM</option><option value="hubspot" disabled={!hubspotStatus.data?.connected}>HubSpot live records{!hubspotStatus.data?.connected ? " (connect first)" : ""}</option><option value="salesforce" disabled={!salesforceStatus.data?.connected}>Salesforce live records{!salesforceStatus.data?.connected ? " (connect first)" : ""}</option>{integration.data?.configured && <option value="both">Local + imported HubSpot</option>}</select></label>
      <p className="w-full text-xs text-muted-foreground">The response uses the selected CRM. Say or type a record request, then review any proposed change before saving.</p>
      <label className="text-sm">Timezone <Input className="inline-block w-48 ml-2" value={timezone} disabled={busy} onChange={event => { setTimezone(event.target.value); setProposal(null); proposalRef.current = null; }} aria-label="Reminder timezone" /></label>
      {contextContact && <Badge>{contextContact.name}<button className="ml-2" aria-label="Clear selected contact" onClick={() => setContextContact(null)}><X className="h-3 w-3" /></button></Badge>}
    </div>
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">{[["Transcription", timings.stt], ["Understand request", timings.intent], ["Read CRM", timings.retrieval], ["First audio playback", timings.playback]].map(([label, value]) => <div className="metric-card !p-3" key={String(label)}><div className="metric-top"><span>{label}</span><Activity className="h-3 w-3" /></div><div className="metric-value !text-xl">{fmt(value as number | null)}</div></div>)}</div>
    {timings.endToEnd !== null && <p className="text-sm text-muted-foreground">End of recording to first playback: {fmt(timings.endToEnd)}</p>}
    {sttDetails && <details className="text-sm text-muted-foreground"><summary className="cursor-pointer">Transcription timing details</summary><p>Audio conversion: {fmt(sttDetails.convert)} · Speech service queue: {fmt(sttDetails.queueWait)} · Model inference: {fmt(sttDetails.inference)}</p><p>Select English or Malay when you know the language to avoid automatic language detection.</p></details>}
    {transcriptionQuality && <p className={`text-sm ${transcriptionQuality.confidence !== null && transcriptionQuality.confidence < 0.72 ? "text-amber-700" : "text-muted-foreground"}`}>{transcriptionQuality.confidence === null ? "Confidence is unavailable for this speech engine." : `Transcription confidence: ${Math.round(transcriptionQuality.confidence * 100)}%.`}{transcriptionQuality.vocabularyMatch ? ` Matched CRM vocabulary: ${transcriptionQuality.vocabularyMatch}.` : ""}{transcriptionQuality.confidence !== null && transcriptionQuality.confidence < 0.72 ? " Review names before using this transcript." : ""}</p>}
    <div className="voice-grid">
      <Card className="surface-card"><CardHeader><p className="eyebrow">01 / capture</p><CardTitle>Record a request</CardTitle></CardHeader><CardContent className="flex flex-col gap-4">
        <div className="flex items-center justify-center gap-3"><div className="voice-ring-ripple" data-recording={phase === "recording"}><div className={`voice-ring ${phase === "recording" ? "recording" : ""}`}><div className="voice-core"><Mic /></div></div></div><span aria-live="polite">{phase === "recording" ? `${language === "en" && dictationReady ? "Listening — English dictation" : dictationReady ? "Listening — Malay" : "Recording — transcribes after Stop"} · ${seconds}s` : phase === "requestingMic" ? "Preparing microphone…" : phase === "transcribing" ? "Transcribing…" : phase === "preparing" ? workflow === "salesforce" ? "Reading Salesforce…" : "Preparing response…" : phase === "speaking" ? "Speaking…" : "Ready"}</span></div>
        <div className="voice-waveform" aria-hidden="true" data-active={phase === "recording" || phase === "speaking"}><span /><span /><span /><span /><span /></div>
        <button className={`record-button ${phase === "recording" ? "active" : ""}`} disabled={phase === "confirming" || phase === "requestingMic"} onClick={() => phase === "recording" ? stopRecording() : void startRecording()}>{phase === "recording" ? <><Square className="h-4 w-4" />Stop recording</> : phase === "speaking" || phase === "preparing" ? <><Mic className="h-4 w-4" />Interrupt and speak</> : <><Mic className="h-4 w-4" />Start recording</>}</button>
        <label className="upload-link">Upload audio<input type="file" accept="audio/*" hidden disabled={busy || phase === "recording"} onChange={event => { const file = event.target.files?.[0]; if (file) { speechEnded.current = null; void uploadAudio(file, file.name); } event.target.value = ""; }} /></label>
        <label className="text-sm"><input type="checkbox" checked={prepareAfterRecording} onChange={event => setPrepareAfterRecording(event.target.checked)} /> Answer my request after transcription</label>
        <fieldset className="rounded-lg border border-border/70 p-3 text-sm" disabled={busy || phase === "recording"}>
          <legend className="px-1 font-medium">Dictation mode</legend>
          <label className="mr-4"><input type="radio" name="transcription-mode" checked={transcriptionMode === "instant"} onChange={() => setTranscriptionMode("instant")} /> Instant (fastest)</label>
          <label><input type="radio" name="transcription-mode" checked={transcriptionMode === "accurate"} onChange={() => setTranscriptionMode("accurate")} /> Accurate (Whisper)</label>
          <p className="mt-2 text-xs text-muted-foreground">{transcriptionMode === "instant" ? "English appears while you speak using the local streaming decoder. It is the lowest-latency option." : "The recording is checked by Whisper after Stop. Use this mode for names, mixed language, and collecting personal-voice training clips."}</p>
        </fieldset>
        <label className="text-sm"><input type="checkbox" checked={livePreview} disabled={busy || phase === "recording" || transcriptionMode === "accurate"} onChange={event => setLivePreview(event.target.checked)} /> Transcribe continuously while speaking</label>
        <label className="text-sm"><input type="checkbox" checked={autoStop} disabled={phase === "recording"} onChange={event => setAutoStop(event.target.checked)} /> Stop automatically after I finish speaking</label>
        <label className="text-sm">Reply language <select className="ml-2 rounded border p-1 bg-background" value={responseLanguage} disabled={busy || phase === "recording"} onChange={event => setResponseLanguage(event.target.value as "en" | "ms")}><option value="en">English</option><option value="ms">Bahasa Melayu</option></select></label>
        <label className="text-sm">Speech language <select className="ml-2 rounded border p-1 bg-background" value={language} disabled={busy || phase === "recording"} onChange={event => setLanguage(event.target.value)}><option value="en">English — live dictation</option><option value="ms">Malay</option></select></label>
        <p className="text-xs text-muted-foreground">Instant English dictation writes words while you speak using a local streaming model. Accurate mode uses Whisper after Stop and is the only mode improved by Whisper fine-tuning. Check names before saving.</p>
      </CardContent></Card>
      <Card className="surface-card"><CardHeader><p className="eyebrow">02 / understand</p><CardTitle>Transcript and response</CardTitle></CardHeader><CardContent className="flex flex-col gap-3">
        <Textarea aria-label="Transcript" rows={5} value={transcript} readOnly={phase === "recording" || phase === "requestingMic"} disabled={phase === "confirming"} onChange={event => { stopResponse(); setExternalReview(null); setTranscript(event.target.value); transcribedRequestRef.current = null; setProposal(null); proposalRef.current = null; setSalesforceContacts([]); setSalesforceContact(null); setSalesforceTasks([]); setSalesforceMessage(""); setPhase("idle"); speechEnded.current = null; }} placeholder={source === "salesforce" ? "Ask: Show my opportunities, or find Acme account." : source === "hubspot" ? "Ask: Show my contacts, or find Acme company." : "Ask about contacts, notes, tasks or follow-ups."} />
        <div className="flex gap-2"><Button className="secondary-button" disabled={!transcript.trim() || busy || phase === "recording"} onClick={() => source === "salesforce" || source === "hubspot" ? void prepareExternal(transcript) : void prepare(transcript)}><Sparkles className="h-4 w-4" />{phase === "preparing" ? "Finding answer…" : "Get CRM answer"}</Button>{(busy || phase === "speaking" || phase === "recording") && phase !== "confirming" && <Button variant="ghost" onClick={() => { if (phase === "recording") { discardRecording.current = true; stopRecording(); } else stopResponse(); setPhase(proposalRef.current ? "reviewing" : "idle"); }}>Cancel</Button>}</div>
        {response && <div className="rounded-lg bg-muted/50 p-3 text-sm leading-relaxed" aria-live="polite"><p className="eyebrow mb-2">CRM response</p><p>{response}</p>{sources.length > 0 && <ul className="text-xs text-muted-foreground mt-3 space-y-1">{sources.map((item, index) => <li key={`${item.provider}-${item.id}-${index}`}>{item.label} · {item.kind} #{item.id}</li>)}</ul>}</div>}
        {playbackBlocked && <Button onClick={() => void audioRef.current?.play().catch(() => toast.error("Audio playback is unavailable"))}><Volume2 />Play response</Button>}
        {workflow === "salesforce" && salesforceMessage && <p className="text-sm text-muted-foreground" role="status">{salesforceMessage}</p>}
        {workflow === "salesforce" && salesforceContacts.length > 0 && <div className="flex flex-wrap gap-2">{salesforceContacts.map(contact => <Button key={contact.Id} variant="outline" size="sm" disabled={busy} onClick={() => void loadSalesforceTasks(contact, turnStarted.current, requestIdRef.current ?? crypto.randomUUID())}>{contact.Name}{contact.Account?.Name ? " · " + contact.Account.Name : ""}{contact.Email ? " · " + contact.Email : ""}</Button>)}</div>}
        {workflow === "salesforce" && salesforceContact && salesforceTasks.length > 0 && <div className="rounded-lg border p-3 text-sm space-y-2"><p className="font-medium">{salesforceContact.Name} · {salesforceTasks.length} open task{salesforceTasks.length === 1 ? "" : "s"}</p>{salesforceTasks.map(task => <p key={task.Id}>{task.Subject} · {task.Status} · {formatSalesforceDate(task.ActivityDate, responseLanguage)}</p>)}</div>}
        {warnings.map((warning, index) => <p className="text-sm text-amber-700" role="status" key={index}>{warning}</p>)}
        {choices.length > 0 && <div className="flex flex-wrap gap-2">{choices.map(choice => <Button key={choice.id} variant="outline" size="sm" disabled={busy} onClick={() => { setContextContact(choice); void prepare(transcript, sessionId, choice.id); }}>{choice.name}{choice.company ? ` · ${choice.company}` : ""}{choice.email ? ` · ${choice.email}` : ""}</Button>)}</div>}
      </CardContent></Card>
    </div>
    {externalReview && <Card className="proposal-card"><div className="proposal-body space-y-3"><p className="eyebrow">Review {source === "salesforce" ? "Salesforce" : "HubSpot"} change</p><p className="whitespace-pre-wrap">{externalReview.text}</p><div className="flex flex-wrap gap-2"><Button variant={externalReview.delete ? "destructive" : "default"} disabled={phase === "confirming"} onClick={() => void decideExternal(true)}>{phase === "confirming" ? "Saving…" : externalReview.delete ? "Confirm delete" : "Confirm change"}</Button><Button variant="outline" disabled={phase === "confirming"} onClick={() => void decideExternal(false)}>Discard</Button></div></div></Card>}
    {proposal && <Card className="proposal-card"><div className="proposal-mark"><Sparkles className="h-4 w-4" /></div><div className="proposal-body"><p className="eyebrow">03 / review and confirm</p><h3>{selected.length} selected action{selected.length === 1 ? "" : "s"}</h3><p className="proposal-reason">Check the transcript, choose the correct contact, and review every detail. Follow-ups are due at 9 AM in {proposal.timezone}.</p>
      <div className="proposal-detail proposal-edit-list">{proposal.actions.map((action, index) => activeActions[index] && <div className="proposal-edit-row" key={index}>
        <Badge variant={action.type === "unsupported" ? "destructive" : "secondary"}>{action.type.replaceAll("_", " ")}</Badge>
        {action.type === "blueprint_action" && (
          <div className="blueprint-proposal-card">
            <Badge variant={action.actionKind === "delete" ? "destructive" : "default"}>{action.actionKind}</Badge>
            <span className="object-label ml-2">{action.objectKey}</span>
            <p className="summary text-sm mt-1">{action.displaySummary}</p>
            {Object.keys(action.fields).length > 0 && (
              <ul className="field-list text-xs mt-1 space-y-0.5">
                {Object.entries(action.fields).map(([k, v]) => (
                  <li key={k}><strong>{k}:</strong> {String(v)}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {action.type !== "blueprint_action" && action.type !== "unsupported" && <ContactPicker value={action.contactId ?? null} label={action.contactName ?? ""} candidates={action.candidates} disabled={phase === "confirming"} onChange={choice => updateAction(index, { contactId: choice?.id ?? null, contactName: choice?.name ?? action.contactName })} />}
        {action.type === "unsupported" && <p>{action.reason || "This action is unsupported"}</p>}
        {action.type === "add_note" && <Textarea aria-label="Note text" value={action.note ?? ""} disabled={phase === "confirming"} onChange={event => updateAction(index, { note: event.target.value })} />}
        {action.type === "create_follow_up" && <><Input aria-label="Follow-up title" value={action.taskTitle ?? ""} disabled={phase === "confirming"} onChange={event => updateAction(index, { taskTitle: event.target.value })} /><Input aria-label="Follow-up date" type="date" value={action.dueDate ?? ""} disabled={phase === "confirming"} onChange={event => updateAction(index, { dueDate: event.target.value, dateExpression: null })} /></>}
        <button className="text-action" aria-label="Remove action" disabled={phase === "confirming"} onClick={() => setActiveActions(value => value.map((active, at) => at === index ? false : active))}><X className="h-4 w-4" /></button>
      </div>)}</div>
      <div className="proposal-actions"><Button className="primary-button" disabled={!canConfirm || busy || phase === "recording"} onClick={() => { if (!sessionId) return; stopResponse(); setPhase("confirming"); confirm.mutate({ sessionId, proposal: { ...proposal, actions: selected } }); }}><Check className="h-4 w-4" />{phase === "confirming" ? "Saving…" : "Confirm and save"}</Button><Button variant="ghost" disabled={phase === "confirming" || reject.isPending} onClick={() => sessionId && reject.mutate({ sessionId })}>Discard</Button></div>
    </div></Card>}
    <div className="flex gap-3"><Button variant="ghost" onClick={() => setShowHistory(!showHistory)}><Clock className="h-4 w-4" />Request history</Button><Button variant="ghost" onClick={() => setShowMetrics(!showMetrics)}><Radio className="h-4 w-4" />Performance</Button></div>
    {showMetrics && <Card><CardHeader><CardTitle>Last 7 days</CardTitle></CardHeader><CardContent><p className="text-sm mb-3">Times in milliseconds. p95 and p99 expose slow outliers that averages hide.</p><table className="w-full text-sm"><thead><tr><th className="text-left">Pipeline stage</th><th>Samples</th><th>p50</th><th>p95</th><th>p99</th><th>Errors</th></tr></thead><tbody>{metricSummary.data?.stages.map(stage => <tr key={stage.stage}><td>{stage.stage}</td><td className="text-center">{stage.count}</td><td className="text-center">{stage.p50Ms ?? "—"}</td><td className="text-center">{stage.p95Ms ?? "—"}</td><td className="text-center">{stage.p99Ms ?? "—"}</td><td className="text-center">{stage.errors}</td></tr>)}</tbody></table>{Boolean(metricSummary.data?.latencyMetrics.length) && <><h3 className="font-medium mt-6 mb-2">User-perceived latency</h3><table className="w-full text-sm"><thead><tr><th className="text-left">Measurement</th><th>Samples</th><th>p50</th><th>p95</th><th>p99</th></tr></thead><tbody>{metricSummary.data?.latencyMetrics.map(metric => <tr key={metric.metric}><td>{metric.metric.replaceAll("_", " ")}</td><td className="text-center">{metric.count}</td><td className="text-center">{metric.p50Ms ?? "—"}</td><td className="text-center">{metric.p95Ms ?? "—"}</td><td className="text-center">{metric.p99Ms ?? "—"}</td></tr>)}</tbody></table></>}{metricSummary.error && <p>Performance data is unavailable.</p>}</CardContent></Card>}
    {showHistory && <Card><CardHeader><CardTitle>Your recent requests</CardTitle></CardHeader><CardContent className="space-y-3">{history.data?.map(item => <details key={item.id}><summary className="cursor-pointer text-sm">#{item.id} · {item.status} · {new Date(item.createdAt).toLocaleString()}</summary><p className="text-sm my-2">{item.transcript || "Typed request"}</p><pre className="text-xs whitespace-pre-wrap break-words">{item.confirmedResultJson ? JSON.stringify(JSON.parse(item.confirmedResultJson), null, 2) : item.proposalJson ? JSON.stringify(JSON.parse(item.proposalJson), null, 2) : "No proposal"}</pre></details>)}{history.data?.length === 0 && <p>No requests yet.</p>}{history.error && <p>Request history is unavailable.</p>}</CardContent></Card>}
  </div>;
}
