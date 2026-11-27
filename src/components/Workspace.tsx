import React, { useCallback, useEffect, useRef, useState } from "react";
import type {
  CallPlatform,
  ChatMessage,
  EngineMode,
  LiveRecordingInfo,
  MeetingMinutes,
  SavedMeeting,
  TemplateId,
  WorkflowStage,
} from "../types";
import {
  findGaps,
  formatCsv,
  formatFollowUpEmail,
  formatMarkdown,
  formatSlack,
  formatTasksMarkdown,
  lineType,
  loadSavedMeetings,
  matchLine,
  names,
  NS,
  offlineAsk,
  runRulesEngine,
  sents,
  storeSavedMeetings,
  TPL,
} from "../utils/meetingEngine";
import { CallRecorder } from "./CallRecorder";

interface WorkspaceProps {
  tpl: TemplateId;
  notes: string;
  mode: EngineMode;
  cur: MeetingMinutes | null;
  statusMsg: string;
  chatMessages: ChatMessage[];
  onChangeTpl: (t: TemplateId) => void;
  onChangeNotes: (n: string) => void;
  onChangeMode: (m: EngineMode) => void;
  onChangeCur: (m: MeetingMinutes | null) => void;
  onStatus: (msg: string) => void;
  onAddChatMessage: (msg: ChatMessage) => void;
}

export const Workspace: React.FC<WorkspaceProps> = ({
  tpl,
  notes,
  mode,
  cur,
  statusMsg,
  chatMessages,
  onChangeTpl,
  onChangeNotes,
  onChangeMode,
  onChangeCur,
  onStatus,
  onAddChatMessage,
}) => {
  const [dateStr, setDateStr] = useState<string>(() =>
    new Date().toISOString().slice(0, 10)
  );
  const [reviewed, setReviewed] = useState(false);
  const [rightView, setRightView] = useState<"src" | "edit">("src");
  const [highlightIdx, setHighlightIdx] = useState<number>(-1);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterTpl, setFilterTpl] = useState<"all" | TemplateId>("all");
  const [savedList, setSavedList] = useState<SavedMeeting[]>(() =>
    loadSavedMeetings()
  );
  const [geminiModel, setGeminiModel] = useState<string>("gemini-4-hydrogen");
  const [askInput, setAskInput] = useState("");
  const [aiBusy, setAiBusy] = useState(false);

  const [platform, setPlatform] = useState<CallPlatform>("website");
  const [meetingLink, setMeetingLink] = useState("");
  const [callTitle, setCallTitle] = useState("");
  const [attachedFileName, setAttachedFileName] = useState("");
  const [workflowStage, setWorkflowStage] = useState<WorkflowStage>("idle");
  const [dragOver, setDragOver] = useState(false);
  const [liveRecording, setLiveRecording] = useState<LiveRecordingInfo | null>(null);
  const [recordedDisclosure, setRecordedDisclosure] = useState<string>("");

  const notesRef = useRef<HTMLTextAreaElement | null>(null);
  const chatBoxRef = useRef<HTMLDivElement | null>(null);
  const rulesTimerRef = useRef<number | null>(null);

  useEffect(() => {
    if (chatBoxRef.current) {
      chatBoxRef.current.scrollTop = chatBoxRef.current.scrollHeight;
    }
  }, [chatMessages]);

  useEffect(() => {
    if (highlightIdx > -1) {
      const el = document.getElementById(`sl${highlightIdx}`);
      el?.scrollIntoView({ block: "nearest" });
    }
  }, [highlightIdx]);

  const generateMinutes = async (
    targetNotes: string,
    targetTpl: TemplateId,
    targetMode: EngineMode,
    targetModel = geminiModel
  ) => {
    const trimmed = targetNotes.trim();
    if (!trimmed) {
      onChangeCur(null);
      setReviewed(false);
      setHighlightIdx(-1);
      onStatus("");
      return;
    }

    if (targetMode === "ai") {
      setAiBusy(true);
      setWorkflowStage("summarizing");
      onStatus(`Asking Gemini (${targetModel})...`);
      try {
        const res = await fetch("/api/gemini/minutes", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            notes: trimmed,
            template: targetTpl,
            model: targetModel,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `Request failed (HTTP ${res.status}).`);
        }
        onChangeCur(data.minutes);
        setHighlightIdx(-1);
        setReviewed(false);
        setWorkflowStage("done");
        onStatus("Gemini minutes ready. Check each item against the source.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        setWorkflowStage("error");
        onStatus(`Could not generate minutes: ${msg}`);
      } finally {
        setAiBusy(false);
      }
      return;
    }

    const generated = runRulesEngine(trimmed);
    onChangeCur(generated);
    setHighlightIdx(-1);
    setReviewed(false);
    setWorkflowStage("done");
    onStatus(`Tagged ${sents(trimmed).length} lines.`);
  };

  const handleProcessVideoUrl = async (
    rawUrl: string,
    overrideTitle?: string,
    overrideTpl?: TemplateId
  ) => {
    const url = rawUrl.trim();
    if (!url) return;

    const targetTpl = overrideTpl || tpl;
    const targetTitle = overrideTitle ?? callTitle;

    onChangeMode("ai");
    setMeetingLink(url);
    setAttachedFileName(targetTitle || url);
    setReviewed(false);
    setAiBusy(true);
    setWorkflowStage("uploading");
    onStatus(
      `Attaching video (${url}) for automated ${TPL[targetTpl].label} summary...`
    );

    const stepTimer1 = window.setTimeout(() => {
      setWorkflowStage((prev) => (prev === "uploading" ? "transcribing" : prev));
      onStatus("Gemini AI is transcribing speakers from the attached Zoom call video...");
    }, 1500);

    const stepTimer2 = window.setTimeout(() => {
      setWorkflowStage((prev) =>
        prev === "transcribing" || prev === "uploading" ? "summarizing" : prev
      );
      onStatus(
        `Generating automated ${TPL[targetTpl].label} summary with ${geminiModel}...`
      );
    }, 5500);

    try {
      const res = await fetch("/api/gemini/process-video-url", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          videoUrl: url,
          template: targetTpl,
          platform,
          callTitle: targetTitle.trim(),
          model: geminiModel,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Processing failed (HTTP ${res.status}).`);
      }

      window.clearTimeout(stepTimer1);
      window.clearTimeout(stepTimer2);

      onChangeNotes(data.transcript);
      onChangeCur(data.minutes);
      setRightView("src");
      setHighlightIdx(-1);
      setWorkflowStage("done");
      onStatus(
        `Automated ${TPL[targetTpl].label} summary ready for "${
          targetTitle.trim() || url
        }". Review against source lines before exporting.`
      );
    } catch (err) {
      window.clearTimeout(stepTimer1);
      window.clearTimeout(stepTimer2);
      const msg =
        err instanceof Error ? err.message : "Could not process attached video URL.";
      setWorkflowStage("error");
      onStatus(`Workflow error: ${msg}`);
    } finally {
      setAiBusy(false);
    }
  };

  const handleLiveRecordingChange = useCallback((info: LiveRecordingInfo | null) => {
    setLiveRecording(info);
  }, []);

  const handleAttachVideoFile = async (file: File) => {
    if (file.size > 250 * 1024 * 1024) {
      setWorkflowStage("error");
      onStatus("Video/audio file exceeds the 250 MB limit.");
      return;
    }

    onChangeMode("ai");
    setAttachedFileName(file.name);
    setReviewed(false);
    setAiBusy(true);
    setWorkflowStage("uploading");
    onStatus(`Uploading "${file.name}" for automated ${TPL[tpl].label} summary...`);

    const stepTimer1 = window.setTimeout(() => {
      setWorkflowStage((prev) => (prev === "uploading" ? "transcribing" : prev));
      onStatus(`Gemini AI is transcribing speakers from "${file.name}"...`);
    }, 1800);

    const stepTimer2 = window.setTimeout(() => {
      setWorkflowStage((prev) =>
        prev === "transcribing" || prev === "uploading" ? "summarizing" : prev
      );
      onStatus(
        `Generating automated ${TPL[tpl].label} summary with ${geminiModel}...`
      );
    }, 6000);

    try {
      const formData = new FormData();
      formData.append("media", file);
      formData.append("template", tpl);
      formData.append("platform", platform);
      formData.append("meetingLink", meetingLink.trim());
      formData.append("callTitle", callTitle.trim());
      formData.append("model", geminiModel);

      const res = await fetch("/api/gemini/process-video", {
        method: "POST",
        body: formData,
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || `Processing failed (HTTP ${res.status}).`);
      }

      window.clearTimeout(stepTimer1);
      window.clearTimeout(stepTimer2);

      onChangeNotes(data.transcript);
      onChangeCur(data.minutes);
      setRightView("src");
      setHighlightIdx(-1);
      setWorkflowStage("done");
      onStatus(
        `Automated ${TPL[tpl].label} summary ready from "${file.name}". Review against source lines before exporting.`
      );
    } catch (err) {
      window.clearTimeout(stepTimer1);
      window.clearTimeout(stepTimer2);
      const msg =
        err instanceof Error ? err.message : "Could not process Zoom/Meet video.";
      setWorkflowStage("error");
      onStatus(`Workflow error: ${msg}`);
    } finally {
      setAiBusy(false);
    }
  };

  const handleNotesChange = (val: string) => {
    onChangeNotes(val);
    setReviewed(false);
    if (mode === "rules") {
      if (rulesTimerRef.current !== null) {
        window.clearTimeout(rulesTimerRef.current);
      }
      rulesTimerRef.current = window.setTimeout(() => {
        void generateMinutes(val, tpl, "rules");
      }, 350);
    }
  };

  const handleTemplateSelect = (nextTpl: TemplateId) => {
    onChangeTpl(nextTpl);
    if (notes.trim()) {
      void generateMinutes(notes, nextTpl, mode);
    } else {
      onStatus(
        `Automated workflow set to ${TPL[nextTpl].label}. Attach your Zoom or Google Meet video to generate minutes.`
      );
    }
  };

  const handleImportTranscript = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const cleaned = String(reader.result || "")
        .replace(/^WEBVTT.*$|^\d+\s*$|^.*-->.*$/gm, "")
        .replace(/\n{2,}/g, "\n")
        .trim();
      onChangeNotes(cleaned);
      setRightView("src");
      void generateMinutes(cleaned, tpl, mode);
    };
    reader.readAsText(file);
  };

  const handleNewMeeting = () => {
    onChangeNotes("");
    onChangeCur(null);
    setReviewed(false);
    setHighlightIdx(-1);
    setMeetingLink("");
    setCallTitle("");
    setAttachedFileName("");
    setRecordedDisclosure("");
    setDateStr(new Date().toISOString().slice(0, 10));
    setWorkflowStage("idle");
    onStatus("Ready. Record a live Zoom / Meet / Website session or attach a video.");
  };

  const handleSaveMeeting = () => {
    if (!cur) return;
    const next: SavedMeeting[] = [
      {
        id: Date.now(),
        title: cur.title,
        notes,
        tpl,
        date: dateStr,
        platform,
        meetingLink: meetingLink.trim() || undefined,
      },
      ...savedList,
    ].slice(0, 30);
    storeSavedMeetings(next);
    setSavedList(next);
    onStatus("Saved to this browser's history.");
  };

  const handleLoadSaved = (m: SavedMeeting) => {
    onChangeTpl(m.tpl);
    onChangeNotes(m.notes);
    if (m.date) setDateStr(m.date);
    if (m.platform) setPlatform(m.platform);
    setMeetingLink(m.meetingLink || "");
    setRightView("src");
    void generateMinutes(m.notes, m.tpl, mode);
  };

  const handleDeleteSaved = (id: number) => {
    const next = savedList.filter((y) => y.id !== id);
    storeSavedMeetings(next);
    setSavedList(next);
  };

  const handleJumpToSource = (sourceText: string) => {
    setRightView("src");
    const lines = sents(notes);
    const idx = lines.findIndex((l) => matchLine(l, sourceText));
    setHighlightIdx(idx);
  };

  const copyText = (txt: string, msg: string) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard
        .writeText(txt)
        .then(() => onStatus(msg))
        .catch(() => fallbackCopy(txt, msg));
      return;
    }
    fallbackCopy(txt, msg);
  };

  const fallbackCopy = (txt: string, msg: string) => {
    const t = document.createElement("textarea");
    t.value = txt;
    t.style.position = "fixed";
    t.style.opacity = "0";
    document.body.appendChild(t);
    t.select();
    try {
      document.execCommand("copy");
      onStatus(msg);
    } catch {
      onStatus("Could not copy automatically. Select the text manually.");
    }
    t.remove();
  };

  const downloadFile = (txt: string, filename: string, type: string) => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([txt], { type }));
    a.download = filename;
    a.click();
  };

  const handleExport = (
    kind: "md" | "pdf" | "csv" | "slack" | "jira" | "notion" | "mail"
  ) => {
    if (!cur) return;
    if (kind === "md") {
      downloadFile(formatMarkdown(cur, dateStr), "meeting-minutes.md", "text/markdown");
    } else if (kind === "csv") {
      downloadFile(formatCsv(cur), "action-items.csv", "text/csv");
    } else if (kind === "pdf") {
      window.print();
    } else if (kind === "slack") {
      copyText(formatSlack(cur), "Slack format copied.");
    } else if (kind === "jira") {
      copyText(formatTasksMarkdown(cur), "Task checklist copied for Jira or Linear.");
    } else if (kind === "notion") {
      copyText(formatMarkdown(cur, dateStr), "Markdown copied for Notion.");
    } else if (kind === "mail") {
      copyText(formatFollowUpEmail(cur), "Follow-up email copied.");
    }
  };

  const handleAsk = async (rawQuestion: string) => {
    const q = rawQuestion.trim();
    if (!q) return;
    onAddChatMessage({ id: `${Date.now()}-u`, role: "u", text: q });

    if (!cur) {
      onAddChatMessage({
        id: `${Date.now()}-b`,
        role: "b",
        text: "Attach a Zoom/Meet video or generate minutes first.",
      });
      return;
    }

    if (mode === "ai") {
      try {
        const res = await fetch("/api/gemini/ask", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            notes,
            question: q,
            template: tpl,
            model: geminiModel,
          }),
        });
        const data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `Request failed (HTTP ${res.status}).`);
        }
        onAddChatMessage({
          id: `${Date.now()}-b`,
          role: "b",
          text: data.answer,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        onAddChatMessage({
          id: `${Date.now()}-b`,
          role: "b",
          text: `Could not ask Gemini: ${msg}`,
        });
      }
      return;
    }

    onAddChatMessage({
      id: `${Date.now()}-b`,
      role: "b",
      text: offlineAsk(q, cur, notes),
    });
  };

  const handleCallRecorded = (
    transcript: string,
    minutes: MeetingMinutes,
    usedPlatform: CallPlatform,
    meta?: { recordedParticipants: string; sourceLabel: string }
  ) => {
    onChangeMode("ai");
    setPlatform(usedPlatform);
    onChangeNotes(transcript);
    onChangeCur(minutes);
    setReviewed(false);
    setHighlightIdx(-1);
    setRightView("src");
    setWorkflowStage("done");
    const platName =
      usedPlatform === "zoom"
        ? "Zoom"
        : usedPlatform === "meet"
        ? "Google Meet"
        : usedPlatform === "website"
        ? "Website / Browser Tab"
        : "Call";
    const disclosure = meta?.recordedParticipants
      ? `Recorded (${meta.sourceLabel || platName}): ${meta.recordedParticipants}`
      : "";
    setRecordedDisclosure(disclosure);
    onStatus(
      `${platName} transcribed & summarized (${TPL[tpl].label}). ${disclosure ? `${disclosure}. ` : ""}Review against source lines before exporting.`
    );
  };

  const handleCanvasDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void handleAttachVideoFile(file);
    }
  };

  const handleCanvasVideoInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (file) {
      void handleAttachVideoFile(file);
    }
  };

  const filteredSaved = savedList.filter(
    (m) =>
      (filterTpl === "all" || m.tpl === filterTpl) &&
      `${m.title}${m.notes}`.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const noteLines = sents(notes);
  const attendeesList = names(notes);
  const gapCount = cur ? findGaps(cur).length : 0;
  const exportsEnabled = reviewed && !!cur;
  const isProcessing =
    aiBusy ||
    workflowStage === "uploading" ||
    workflowStage === "transcribing" ||
    workflowStage === "summarizing";

  const stepClass = (step: 1 | 2 | 3 | 4) => {
    if (workflowStage === "done") return "wf-step done";
    if (workflowStage === "uploading") {
      return step === 1 ? "wf-step active" : "wf-step";
    }
    if (workflowStage === "transcribing") {
      if (step === 1) return "wf-step done";
      if (step === 2) return "wf-step active";
      return "wf-step";
    }
    if (workflowStage === "summarizing") {
      if (step <= 2) return "wf-step done";
      if (step === 3) return "wf-step active";
      return "wf-step";
    }
    return "wf-step";
  };

  return (
    <section id="app">
      <div className="wrap">
        <p className="sc">Workspace</p>
        <h2>Review, edit, export</h2>
        <p className="lead">
          Left: attach a Zoom or Google Meet video, record live, and pick your
          meeting template. Center: automated Gemini minutes, editable in place.
          Right: colour-coded source transcript and Ask AI.
        </p>

        <div className="ws">
          {/* Left Pane */}
          <aside className="pane" aria-label="Meetings">
            <button
              className="btn btn-block"
              type="button"
              id="newm"
              onClick={handleNewMeeting}
            >
              + New meeting
            </button>

            <label className="btn g btn-block mt-10">
              Import transcript
              <input
                type="file"
                id="imp"
                accept=".txt,.md,.vtt,.srt"
                hidden
                onChange={handleImportTranscript}
              />
            </label>

            <label className="label-sm" htmlFor="active-tpl">
              Meeting type (summary template)
            </label>
            <select
              id="active-tpl"
              className="f"
              value={tpl}
              disabled={isProcessing}
              onChange={(e) => handleTemplateSelect(e.target.value as TemplateId)}
            >
              <option value="general">General sync</option>
              <option value="standup">Standup</option>
              <option value="sales">Sales call</option>
              <option value="one">1:1</option>
              <option value="board">Board minutes</option>
            </select>

            <CallRecorder
              template={tpl}
              platform={platform}
              meetingLink={meetingLink}
              callTitle={callTitle}
              isProcessingExternal={isProcessing}
              onChangePlatform={setPlatform}
              onChangeMeetingLink={setMeetingLink}
              onChangeCallTitle={setCallTitle}
              onAttachVideoFile={(f) => void handleAttachVideoFile(f)}
              onProcessVideoUrl={(url) => void handleProcessVideoUrl(url)}
              onLiveRecordingChange={handleLiveRecordingChange}
              onStatus={onStatus}
              onTranscribedAndSummarized={handleCallRecorded}
            />

            <input
              className="f mt-12"
              id="q"
              type="search"
              placeholder="Search meetings"
              aria-label="Search meetings"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            <select
              className="f"
              id="tf"
              aria-label="Filter by template"
              value={filterTpl}
              onChange={(e) => setFilterTpl(e.target.value as "all" | TemplateId)}
            >
              <option value="all">All templates</option>
              <option value="general">General</option>
              <option value="standup">Standup</option>
              <option value="sales">Sales call</option>
              <option value="one">1:1</option>
              <option value="board">Board minutes</option>
            </select>

            <div id="hist">
              {!filteredSaved.length ? (
                <p className="note">
                  No saved meetings yet. Attach a video or generate minutes, then
                  press Save.
                </p>
              ) : (
                filteredSaved.map((m) => (
                  <div className="mt" key={m.id}>
                    <button type="button" onClick={() => handleLoadSaved(m)}>
                      {m.title}
                    </button>
                    <button
                      type="button"
                      aria-label={`Delete ${m.title}`}
                      onClick={() => handleDeleteSaved(m.id)}
                    >
                      &times;
                    </button>
                  </div>
                ))
              )}
            </div>

            <div className="pane-divider">
              <h3 className="pane-subhead">Engine</h3>
              <div className="opt">
                <label>
                  <input
                    type="radio"
                    name="mode"
                    value="rules"
                    checked={mode === "rules"}
                    onChange={() => {
                      onChangeMode("rules");
                      void generateMinutes(notes, tpl, "rules");
                    }}
                  />{" "}
                  Offline
                </label>
                <label>
                  <input
                    type="radio"
                    name="mode"
                    value="ai"
                    checked={mode === "ai"}
                    onChange={() => {
                      onChangeMode("ai");
                      if (notes.trim()) {
                        void generateMinutes(notes, tpl, "ai");
                      }
                    }}
                  />{" "}
                  AI model
                </label>
              </div>

              {mode === "ai" && (
                <div id="aibox">
                  <label className="label-sm" htmlFor="gemini-model">
                    Attached Gemini model
                  </label>
                  <select
                    id="gemini-model"
                    className="f"
                    value={geminiModel}
                    disabled={isProcessing}
                    onChange={(e) => setGeminiModel(e.target.value)}
                    aria-label="Gemini model"
                  >
                    <option value="gemini-4-hydrogen">
                      Gemini 4 Hydrogen (default)
                    </option>
                    <option value="gemini-3.1-flash-lite">
                      Gemini 3.1 Flash Lite (fast)
                    </option>
                  </select>
                  <button
                    className="btn g btn-sm mt-6"
                    type="button"
                    id="reg"
                    disabled={isProcessing || !notes.trim()}
                    onClick={() => void generateMinutes(notes, tpl, "ai", geminiModel)}
                  >
                    {aiBusy ? "Generating..." : "Generate with Gemini"}
                  </button>
                  <p className="note" id="keynote">
                    Automated AI mode powered by {geminiModel} on the server.
                  </p>
                </div>
              )}
            </div>
          </aside>

          {/* Center Pane */}
          <main className="pane ctr" aria-label="Minutes">
            <div className="xbar">
              <button
                className="btn btn-sm"
                type="button"
                id="sv"
                disabled={!cur}
                onClick={handleSaveMeeting}
              >
                Save
              </button>
              <label className="rv">
                <input
                  type="checkbox"
                  id="rv"
                  checked={reviewed}
                  onChange={(e) => setReviewed(e.target.checked)}
                />{" "}
                Reviewed against notes
              </label>
              <button
                className="btn g gx"
                type="button"
                disabled={!exportsEnabled}
                onClick={() => handleExport("md")}
              >
                Markdown
              </button>
              <button
                className="btn g gx"
                type="button"
                disabled={!exportsEnabled}
                onClick={() => handleExport("pdf")}
              >
                PDF
              </button>
              <button
                className="btn g gx"
                type="button"
                disabled={!exportsEnabled}
                onClick={() => handleExport("csv")}
              >
                CSV
              </button>
              <button
                className="btn g gx"
                type="button"
                disabled={!exportsEnabled}
                onClick={() => handleExport("slack")}
              >
                Slack
              </button>
              <button
                className="btn g gx"
                type="button"
                disabled={!exportsEnabled}
                onClick={() => handleExport("jira")}
              >
                Jira/Linear
              </button>
              <button
                className="btn g gx"
                type="button"
                disabled={!exportsEnabled}
                onClick={() => handleExport("notion")}
              >
                Notion
              </button>
              <button
                className="btn g gx"
                type="button"
                disabled={!exportsEnabled}
                onClick={() => handleExport("mail")}
              >
                Email
              </button>
            </div>

            <div className="canvas" id="out">
              {liveRecording && (
                <div className="canvas-rec-banner" role="status" aria-live="polite">
                  <strong>
                    {liveRecording.paused ? "RECORDING PAUSED" : "LIVE RECORDING ACTIVE"} — PARTICIPANTS INFORMED
                  </strong>
                  <span>
                    <b>Being recorded:</b> {liveRecording.recordedParticipants} ·{" "}
                    <b>Source:</b> {liveRecording.sourceLabel} (
                    {liveRecording.hasVideo ? "Video + Audio" : "Audio"})
                  </span>
                </div>
              )}

              {!cur ? (
                <>
                  <h3 className="ct">
                    {callTitle.trim() || "Automated Meeting Workflow"}
                  </h3>
                  <div className="meta">
                    <input
                      type="date"
                      value={dateStr}
                      aria-label="Meeting date"
                      onChange={(e) => setDateStr(e.target.value)}
                    />
                    <span>Template: {TPL[tpl].label}</span>
                    <span>
                      Source:{" "}
                      {platform === "zoom"
                        ? "Zoom"
                        : platform === "meet"
                        ? "Google Meet"
                        : platform === "website"
                        ? "Website / Tab"
                        : "Microphone"}
                    </span>
                    <span>
                      Engine:{" "}
                      {mode === "ai"
                        ? `Gemini (${geminiModel})`
                        : "Offline rules"}
                    </span>
                  </div>

                  <div
                    className={`dropzone${dragOver ? " drag-over" : ""}`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragOver(true);
                    }}
                    onDragLeave={() => setDragOver(false)}
                    onDrop={handleCanvasDrop}
                  >
                    <h4>
                      {isProcessing
                        ? "Generating automated Gemini AI summary..."
                        : "Attach your Zoom or Google Meet video"}
                    </h4>
                    <p>
                      Drop an .mp4, .webm, .mov, .mkv or audio file here, or
                      paste a video URL. Gemini AI will transcribe the speakers
                      and automatically generate your{" "}
                      <strong>{TPL[tpl].label}</strong> summary, decisions,
                      action items and open questions.
                    </p>
                    <div className="row">
                      <label className="btn btn-sm">
                        {isProcessing
                          ? "Processing video..."
                          : "Choose Zoom / Meet video"}
                        <input
                          type="file"
                          accept="video/*,.mp4,.webm,.mov,.mkv,.avi,audio/*,.mp3,.wav,.m4a,.ogg"
                          hidden
                          disabled={isProcessing}
                          onChange={handleCanvasVideoInput}
                        />
                      </label>
                      {meetingLink.trim() && (
                        <button
                          type="button"
                          className="btn g btn-sm"
                          disabled={isProcessing}
                          onClick={() =>
                            void handleProcessVideoUrl(meetingLink.trim())
                          }
                        >
                          Summarize attached URL
                        </button>
                      )}
                    </div>
                    {attachedFileName && (
                      <div>
                        <span className="file-chip">
                          Attached: {attachedFileName}
                        </span>
                      </div>
                    )}
                  </div>

                  <div className="wf-steps" aria-label="Automated workflow stages">
                    <div className={stepClass(1)}>
                      <b>1. Attach</b>
                      Zoom / Meet video or URL
                    </div>
                    <div className={stepClass(2)}>
                      <b>2. Transcribe</b>
                      Gemini AI speaker transcript
                    </div>
                    <div className={stepClass(3)}>
                      <b>3. Summarize</b>
                      {TPL[tpl].label} decisions &amp; tasks
                    </div>
                    <div className={stepClass(4)}>
                      <b>4. Export</b>
                      Verify &amp; share minutes
                    </div>
                  </div>

                  {statusMsg && <p className="src">{statusMsg}</p>}
                </>
              ) : (
                <>
                  <h3 className="ct">{cur.title}</h3>
                  <div className="meta">
                    <input
                      type="date"
                      value={dateStr}
                      aria-label="Meeting date"
                      onChange={(e) => setDateStr(e.target.value)}
                    />
                    <span>Template: {TPL[tpl].label}</span>
                    <span>
                      Attendees: {attendeesList.join(", ") || "not listed"}
                    </span>
                    {recordedDisclosure && <span>{recordedDisclosure}</span>}
                    {meetingLink.trim() && (
                      <span>Source: {meetingLink.trim()}</span>
                    )}
                  </div>

                  {gapCount > 0 && (
                    <p className="warn">
                      {gapCount} action item(s) need an owner or due date before you
                      share.
                    </p>
                  )}

                  <h3>Executive summary</h3>
                  <ul>
                    {cur.summary.map((item, idx) => (
                      <li key={`${idx}-${item.slice(0, 12)}`}>
                        <span
                          contentEditable
                          suppressContentEditableWarning
                          onBlur={(e) => {
                            const nextSummary = [...cur.summary];
                            nextSummary[idx] = e.currentTarget.textContent || "";
                            onChangeCur({ ...cur, summary: nextSummary });
                          }}
                        >
                          {item}
                        </span>
                      </li>
                    ))}
                  </ul>

                  <h3>Key decisions</h3>
                  {!cur.decisions.length ? (
                    <p>No confirmed decisions.</p>
                  ) : (
                    cur.decisions.map((dec, idx) => (
                      <div className="cal" key={`dec-${idx}`}>
                        <span
                          contentEditable
                          suppressContentEditableWarning
                          onBlur={(e) => {
                            const nextDecisions = [...cur.decisions];
                            nextDecisions[idx] = {
                              ...nextDecisions[idx],
                              text: e.currentTarget.textContent || "",
                            };
                            onChangeCur({ ...cur, decisions: nextDecisions });
                          }}
                        >
                          {dec.text}
                        </span>
                        {dec.source && (
                          <button
                            type="button"
                            className="lk"
                            onClick={() => handleJumpToSource(dec.source)}
                          >
                            source
                          </button>
                        )}
                      </div>
                    ))
                  )}

                  <h3>Action items</h3>
                  {!cur.actions.length ? (
                    <p>No action items found.</p>
                  ) : (
                    cur.actions.map((act, idx) => {
                      const ownerVal = act.owner && act.owner !== NS ? act.owner : "";
                      const dueVal =
                        act.deadline && act.deadline !== NS ? act.deadline : "";
                      return (
                        <div
                          className={`ar${act.done ? " done" : ""}`}
                          key={`act-${idx}`}
                        >
                          <input
                            type="checkbox"
                            checked={!!act.done}
                            aria-label="Mark done"
                            onChange={(e) => {
                              const nextActions = [...cur.actions];
                              nextActions[idx] = {
                                ...nextActions[idx],
                                done: e.target.checked,
                              };
                              onChangeCur({ ...cur, actions: nextActions });
                            }}
                          />
                          <input
                            type="text"
                            className="t"
                            value={act.task}
                            aria-label="Task"
                            onChange={(e) => {
                              const nextActions = [...cur.actions];
                              nextActions[idx] = {
                                ...nextActions[idx],
                                task: e.target.value,
                              };
                              onChangeCur({ ...cur, actions: nextActions });
                            }}
                          />
                          <input
                            type="text"
                            placeholder="Owner"
                            aria-label="Owner"
                            value={ownerVal}
                            className={ownerVal ? "" : "bad"}
                            onChange={(e) => {
                              const nextActions = [...cur.actions];
                              nextActions[idx] = {
                                ...nextActions[idx],
                                owner: e.target.value || NS,
                              };
                              onChangeCur({ ...cur, actions: nextActions });
                            }}
                          />
                          <input
                            type="text"
                            placeholder="Due"
                            aria-label="Due date"
                            value={dueVal}
                            className={dueVal ? "" : "bad"}
                            onChange={(e) => {
                              const nextActions = [...cur.actions];
                              nextActions[idx] = {
                                ...nextActions[idx],
                                deadline: e.target.value || NS,
                              };
                              onChangeCur({ ...cur, actions: nextActions });
                            }}
                          />
                          {act.source ? (
                            <button
                              type="button"
                              className="lk"
                              onClick={() => handleJumpToSource(act.source)}
                            >
                              source
                            </button>
                          ) : (
                            <span />
                          )}
                        </div>
                      );
                    })
                  )}

                  <h3>Open questions</h3>
                  {!cur.questions.length ? (
                    <p>No open questions.</p>
                  ) : (
                    <ul>
                      {cur.questions.map((qItem, idx) => (
                        <li key={`q-${idx}`}>
                          <span
                            contentEditable
                            suppressContentEditableWarning
                            onBlur={(e) => {
                              const nextQuestions = [...cur.questions];
                              nextQuestions[idx] = {
                                ...nextQuestions[idx],
                                text: e.currentTarget.textContent || "",
                              };
                              onChangeCur({ ...cur, questions: nextQuestions });
                            }}
                          >
                            {qItem.text}
                          </span>
                          {qItem.source && (
                            <button
                              type="button"
                              className="lk"
                              onClick={() => handleJumpToSource(qItem.source)}
                            >
                              source
                            </button>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  <p className="src">
                    AI-assisted draft. Reviewed by a team member before sharing.
                  </p>
                </>
              )}
            </div>
          </main>

          {/* Right Pane */}
          <aside className="pane" aria-label="Source and Ask AI">
            <div className="row mb-8">
              <button
                type="button"
                className={
                  rightView === "src" ? "btn btn-sm" : "btn g btn-sm"
                }
                id="vs"
                onClick={() => setRightView("src")}
              >
                Source
              </button>
              <button
                type="button"
                className={
                  rightView === "edit" ? "btn btn-sm" : "btn g btn-sm"
                }
                id="ve"
                onClick={() => {
                  setRightView("edit");
                  window.setTimeout(() => notesRef.current?.focus(), 0);
                }}
              >
                Edit notes
              </button>
            </div>

            {rightView === "src" ? (
              <div id="srcv">
                {!noteLines.length ? (
                  <p className="note">
                    No transcript or notes yet. Attach a Zoom/Google Meet video
                    or choose Edit notes to paste text.
                  </p>
                ) : (
                  noteLines.map((line, i) => (
                    <div
                      key={`sl-${i}`}
                      id={`sl${i}`}
                      className={`sl ${lineType(line, cur)}${
                        i === highlightIdx ? " hl" : ""
                      }`}
                    >
                      <b>{i + 1}</b>
                      <span>{line}</span>
                    </div>
                  ))
                )}
              </div>
            ) : (
              <textarea
                ref={notesRef}
                id="notes"
                rows={12}
                aria-label="Meeting notes"
                value={notes}
                onChange={(e) => handleNotesChange(e.target.value)}
              />
            )}

            <p className="note" id="st" role="status">
              {statusMsg}
            </p>

            <div className="chatb">
              <div className="chat-header">
                <h3 className="pane-subhead">Ask AI</h3>
              </div>

              <div id="chat" ref={chatBoxRef}>
                {chatMessages.map((m) => (
                  <div
                    key={m.id}
                    className={`cm ${m.role}${m.typing ? " typ" : ""}`}
                  >
                    {m.text}
                  </div>
                ))}
              </div>

              <div className="try">
                <button
                  type="button"
                  onClick={() => void handleAsk("Draft a follow-up email")}
                >
                  Follow-up email
                </button>
                <button
                  type="button"
                  onClick={() => void handleAsk("Who owns what?")}
                >
                  Who owns what?
                </button>
                <button
                  type="button"
                  onClick={() => void handleAsk("What is unresolved?")}
                >
                  Unresolved
                </button>
              </div>

              <div className="row">
                <input
                  className="f ask-input"
                  id="ask"
                  type="text"
                  placeholder="Ask about the meeting"
                  aria-label="Ask about the meeting"
                  value={askInput}
                  onChange={(e) => setAskInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      const val = askInput;
                      setAskInput("");
                      void handleAsk(val);
                    }
                  }}
                />
                <button
                  className="btn btn-sm"
                  type="button"
                  id="send"
                  onClick={() => {
                    const val = askInput;
                    setAskInput("");
                    void handleAsk(val);
                  }}
                >
                  Ask
                </button>
              </div>
            </div>
          </aside>
        </div>
      </div>
    </section>
  );
};
