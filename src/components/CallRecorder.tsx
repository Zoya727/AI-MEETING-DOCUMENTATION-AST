import React, { useEffect, useRef, useState } from "react";
import type {
  CallPlatform,
  LiveRecordingInfo,
  MeetingMinutes,
  TemplateId,
} from "../types";
import { TPL } from "../utils/meetingEngine";

export interface ZoomLocalFileItem {
  name: string;
  lastModified: number;
  file: File;
}

interface CallRecorderProps {
  template: TemplateId;
  platform: CallPlatform;
  meetingLink: string;
  callTitle: string;
  isProcessingExternal: boolean;
  onChangePlatform: (p: CallPlatform) => void;
  onChangeMeetingLink: (link: string) => void;
  onChangeCallTitle: (title: string) => void;
  onAttachVideoFile: (file: File) => void;
  onProcessVideoUrl: (url: string) => void;
  onLiveRecordingChange: (info: LiveRecordingInfo | null) => void;
  onStatus: (msg: string) => void;
  onTranscribedAndSummarized: (
    transcript: string,
    minutes: MeetingMinutes,
    platform: CallPlatform,
    meta?: { recordedParticipants: string; sourceLabel: string }
  ) => void;
}

type RecState = "idle" | "recording" | "paused" | "processing";
type CaptureTarget = "webpage" | "call" | "mic";

const MEDIA_EXT_RE = /\.(mp4|mov|webm|mkv|avi|m4v|m4a|mp3|wav|ogg)$/i;

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function platformDisplayName(p: CallPlatform): string {
  if (p === "zoom") return "Zoom";
  if (p === "meet") return "Google Meet";
  if (p === "website") return "My Webpage";
  return "Microphone";
}

function defaultParticipantsLabel(p: CallPlatform, withMic: boolean): string {
  if (p === "zoom") {
    return withMic ? "All Zoom call participants + your mic" : "All Zoom call participants";
  }
  if (p === "meet") {
    return withMic
      ? "All Google Meet participants + your mic"
      : "All Google Meet participants";
  }
  if (p === "website") {
    return withMic
      ? "This webpage session + your microphone"
      : "This webpage screen & tab audio";
  }
  return "Your microphone only";
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(new Error("Could not read recorded media."));
    reader.readAsDataURL(blob);
  });
}

async function scanDirectoryForMedia(
  dirHandle: FileSystemDirectoryHandle,
  depth = 0
): Promise<ZoomLocalFileItem[]> {
  const found: ZoomLocalFileItem[] = [];
  if (depth > 3) return found;

  const entries = (
    dirHandle as unknown as {
      values: () => AsyncIterable<FileSystemHandle>;
    }
  ).values();

  for await (const entry of entries) {
    if (entry.kind === "file") {
      if (MEDIA_EXT_RE.test(entry.name)) {
        const fileHandle = entry as FileSystemFileHandle;
        const file = await fileHandle.getFile();
        if (file.size > 0) {
          found.push({
            name: file.name,
            lastModified: file.lastModified,
            file,
          });
        }
      }
    } else if (entry.kind === "directory") {
      const sub = await scanDirectoryForMedia(
        entry as FileSystemDirectoryHandle,
        depth + 1
      );
      found.push(...sub);
    }
  }
  return found;
}

export const CallRecorder: React.FC<CallRecorderProps> = ({
  template,
  platform,
  meetingLink,
  callTitle,
  isProcessingExternal,
  onChangePlatform,
  onChangeMeetingLink,
  onChangeCallTitle,
  onAttachVideoFile,
  onProcessVideoUrl,
  onLiveRecordingChange,
  onStatus,
  onTranscribedAndSummarized,
}) => {
  const [includeMic, setIncludeMic] = useState(true);
  const [captureVideo, setCaptureVideo] = useState(true);
  const [recState, setRecState] = useState<RecState>("idle");
  const [elapsed, setElapsed] = useState(0);
  const [level, setLevel] = useState(0);
  const [warning, setWarning] = useState("");
  const [error, setError] = useState("");

  // "Who is being recorded" disclosure state
  const [whoRecorded, setWhoRecorded] = useState(() =>
    defaultParticipantsLabel(platform, true)
  );
  const [whoEdited, setWhoEdited] = useState(false);
  const [activeSourceLabel, setActiveSourceLabel] = useState("");
  const [hasRecordedVideo, setHasRecordedVideo] = useState(false);
  const [noticeCopied, setNoticeCopied] = useState(false);

  // Zoom Local Folder Access state
  const [zoomFiles, setZoomFiles] = useState<ZoomLocalFileItem[]>([]);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamsRef = useRef<MediaStream[]>([]);
  const previewStreamRef = useRef<MediaStream | null>(null);
  const previewVideoRef = useRef<HTMLVideoElement | null>(null);
  const audioCtxRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const timerRef = useRef<number | null>(null);
  const mimeRef = useRef<string>("audio/webm");
  const folderFallbackRef = useRef<HTMLInputElement | null>(null);

  const whoRecordedRef = useRef(whoRecorded);
  whoRecordedRef.current = whoRecorded;
  const activeSourceLabelRef = useRef(activeSourceLabel);
  activeSourceLabelRef.current = activeSourceLabel;

  const cleanupStreams = () => {
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    streamsRef.current.forEach((s) => {
      s.getTracks().forEach((t) => t.stop());
    });
    streamsRef.current = [];
    previewStreamRef.current = null;
    if (previewVideoRef.current) {
      previewVideoRef.current.srcObject = null;
    }
    if (audioCtxRef.current) {
      audioCtxRef.current.close().catch(() => undefined);
      audioCtxRef.current = null;
    }
    setLevel(0);
  };

  useEffect(() => {
    return () => {
      cleanupStreams();
    };
  }, []);

  useEffect(() => {
    if (
      (recState === "recording" || recState === "paused") &&
      previewVideoRef.current &&
      previewStreamRef.current
    ) {
      previewVideoRef.current.srcObject = previewStreamRef.current;
    }
  }, [recState, hasRecordedVideo]);

  useEffect(() => {
    if (recState === "recording" || recState === "paused") {
      onLiveRecordingChange({
        active: true,
        paused: recState === "paused",
        platform,
        sourceLabel: activeSourceLabel || platformDisplayName(platform),
        recordedParticipants: whoRecorded,
        elapsedSeconds: elapsed,
        hasVideo: hasRecordedVideo,
      });
    } else {
      onLiveRecordingChange(null);
    }
  }, [
    recState,
    platform,
    activeSourceLabel,
    whoRecorded,
    elapsed,
    hasRecordedVideo,
    onLiveRecordingChange,
  ]);

  const handleGrantZoomFolderAccess = async () => {
    setError("");
    setWarning("");
    const picker = (
      window as unknown as {
        showDirectoryPicker?: (opts?: {
          mode?: "read" | "readwrite";
        }) => Promise<FileSystemDirectoryHandle>;
      }
    ).showDirectoryPicker;

    if (typeof picker === "function") {
      try {
        const dirHandle = await picker({ mode: "read" });
        onStatus("Scanning your Zoom recordings folder...");
        const media = await scanDirectoryForMedia(dirHandle);
        media.sort((a, b) => b.lastModified - a.lastModified);
        setZoomFiles(media);
        if (media.length === 0) {
          setWarning(
            "No Zoom video/audio files (.mp4, .m4a, .webm, .mov) found in that folder."
          );
          return;
        }
        onChangePlatform("zoom");
        onChangeCallTitle(
          media[0].name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ")
        );
        onAttachVideoFile(media[0].file);
        return;
      } catch (err) {
        const name = err instanceof Error ? err.name : "";
        if (name === "AbortError") return;
      }
    }

    folderFallbackRef.current?.click();
  };

  const handleFolderFallbackChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (!files.length) return;
    const media = files
      .filter((f) => MEDIA_EXT_RE.test(f.name) && f.size > 0)
      .map((file) => ({ name: file.name, lastModified: file.lastModified, file }))
      .sort((a, b) => b.lastModified - a.lastModified);

    setZoomFiles(media);
    if (media.length === 0) {
      setWarning("No video/audio recordings found in that folder.");
      return;
    }
    onChangePlatform("zoom");
    onChangeCallTitle(
      media[0].name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ")
    );
    onAttachVideoFile(media[0].file);
  };

  const submitRecordingForSummary = async (
    blob: Blob,
    mimeType: string,
    usedPlatform: CallPlatform,
    recordedParticipants: string,
    sourceLabel: string,
    containsVideo: boolean
  ) => {
    setRecState("processing");
    setError("");
    onStatus(
      `Transcribing ${platformDisplayName(usedPlatform)} recording (${recordedParticipants}) & summarizing as ${TPL[template].label} with Gemini...`
    );

    try {
      let data: { transcript: string; minutes: MeetingMinutes; error?: string };

      if (containsVideo) {
        const formData = new FormData();
        const ext = mimeType.includes("mp4") ? "mp4" : "webm";
        const fileName = `${usedPlatform}-live-recording.${ext}`;
        formData.append("media", new File([blob], fileName, { type: mimeType }));
        formData.append("template", template);
        formData.append("platform", usedPlatform);
        formData.append("meetingLink", meetingLink.trim());
        formData.append(
          "callTitle",
          callTitle.trim() ||
            sourceLabel ||
            `${platformDisplayName(usedPlatform)} Recording`
        );
        formData.append("recordedParticipants", recordedParticipants);
        formData.append("sourceLabel", sourceLabel);

        const res = await fetch("/api/gemini/process-video", {
          method: "POST",
          body: formData,
        });
        data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `Request failed (HTTP ${res.status}).`);
        }
      } else {
        const audioBase64 = await blobToBase64(blob);
        const res = await fetch("/api/gemini/record-summarize", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audioBase64,
            mimeType,
            template,
            platform: usedPlatform,
            callTitle: callTitle.trim() || sourceLabel,
            recordedParticipants,
            sourceLabel,
          }),
        });
        data = await res.json();
        if (!res.ok) {
          throw new Error(data.error || `Request failed (HTTP ${res.status}).`);
        }
      }

      onTranscribedAndSummarized(data.transcript, data.minutes, usedPlatform, {
        recordedParticipants,
        sourceLabel,
      });
      setRecState("idle");
      setElapsed(0);
      setWarning("");
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Failed to summarize recording.";
      setError(msg);
      onStatus(`Could not transcribe/summarize recording: ${msg}`);
      setRecState("idle");
    }
  };

  // IMPORTANT: Keep getDisplayMedia() as the VERY FIRST async call inside the
  // button click handler with zero `await` statements before it so browsers
  // always recognize the transient user gesture activation.
  const startRecording = async (target: CaptureTarget) => {
    setError("");
    setWarning("");
    setNoticeCopied(false);

    if (!navigator.mediaDevices || typeof MediaRecorder === "undefined") {
      setError("Live recording is not supported in this browser.");
      return;
    }

    const effectivePlatform: CallPlatform =
      target === "webpage"
        ? "website"
        : target === "mic"
        ? "mic"
        : platform === "mic" || platform === "website"
        ? "zoom"
        : platform;

    if (effectivePlatform !== platform) {
      onChangePlatform(effectivePlatform);
    }

    const participantsLabel = whoEdited
      ? whoRecorded.trim() || defaultParticipantsLabel(effectivePlatform, includeMic)
      : defaultParticipantsLabel(effectivePlatform, includeMic);
    setWhoRecorded(participantsLabel);

    const capturedStreams: MediaStream[] = [];
    streamsRef.current = capturedStreams;

    try {
      let displayVideoTracks: MediaStreamTrack[] = [];
      let displayAudioTracks: MediaStreamTrack[] = [];
      let micStream: MediaStream | null = null;
      let detectedSource =
        target === "webpage"
          ? document.title || "This Webpage"
          : meetingLink.trim() ||
            callTitle.trim() ||
            platformDisplayName(effectivePlatform);

      if (target === "webpage" || target === "call") {
        if (!navigator.mediaDevices.getDisplayMedia) {
          throw new Error(
            "Webpage / tab capture is unavailable in this browser context. Try opening the app in a standalone tab or use Microphone Only."
          );
        }

        const displayConstraints: DisplayMediaStreamOptions = (
          target === "webpage"
            ? {
                video: true,
                audio: {
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false,
                },
                preferCurrentTab: true,
                systemAudio: "include",
              }
            : {
                video: true,
                audio: {
                  echoCancellation: false,
                  noiseSuppression: false,
                  autoGainControl: false,
                },
                selfBrowserSurface: "include",
                systemAudio: "include",
                surfaceSwitching: "include",
              }
        ) as unknown as DisplayMediaStreamOptions;

        // First call in click handler — preserves browser user gesture!
        const displayStream =
          await navigator.mediaDevices.getDisplayMedia(displayConstraints);

        capturedStreams.push(displayStream);
        displayVideoTracks = displayStream.getVideoTracks();
        displayAudioTracks = displayStream.getAudioTracks();

        const rawTrackLabel =
          displayVideoTracks[0]?.label || displayAudioTracks[0]?.label || "";
        if (rawTrackLabel && !/^screen:/i.test(rawTrackLabel)) {
          detectedSource =
            target === "webpage" && /^current-?web-?contents/i.test(rawTrackLabel)
              ? document.title || "This Webpage"
              : rawTrackLabel;
        }

        if (!captureVideo) {
          displayVideoTracks.forEach((vt) => vt.stop());
          displayVideoTracks = [];
        }

        // Acquire microphone after display capture so mic permission prompt never steals focus or breaks user gesture
        if (includeMic) {
          try {
            micStream = await navigator.mediaDevices.getUserMedia({
              audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
              },
            });
            capturedStreams.push(micStream);
          } catch {
            setWarning(
              "Microphone permission was denied — recording webpage / call stream without mic."
            );
          }
        }

        if (displayAudioTracks.length === 0 && !micStream && displayVideoTracks.length === 0) {
          throw new Error(
            'No webpage video, tab audio, or microphone was shared. Please allow screen/tab sharing or microphone access.'
          );
        }

        if (displayAudioTracks.length === 0) {
          setWarning((prev) =>
            prev
              ? `${prev} Tab audio was also not shared.`
              : 'Tab audio was not shared — recording webpage video + microphone. Enable "Share tab audio" next time to capture call audio too.'
          );
        }
      } else {
        // Microphone only
        micStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        capturedStreams.push(micStream);
        detectedSource = "Microphone input";
      }

      setActiveSourceLabel(detectedSource);

      const audioCtx = new AudioContext();
      if (audioCtx.state === "suspended") {
        await audioCtx.resume();
      }
      audioCtxRef.current = audioCtx;
      const dest = audioCtx.createMediaStreamDestination();
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;

      let hasAudioSource = false;

      if (displayAudioTracks.length > 0) {
        const displayAudioStream = new MediaStream(displayAudioTracks);
        const displaySource = audioCtx.createMediaStreamSource(displayAudioStream);
        displaySource.connect(dest);
        displaySource.connect(analyser);
        hasAudioSource = true;
      }

      if (micStream && micStream.getAudioTracks().length > 0) {
        const micSource = audioCtx.createMediaStreamSource(micStream);
        micSource.connect(dest);
        micSource.connect(analyser);
        hasAudioSource = true;
      }

      const recordingVideo = captureVideo && displayVideoTracks.length > 0;
      setHasRecordedVideo(recordingVideo);

      const combinedTracks: MediaStreamTrack[] = [];
      if (recordingVideo) {
        combinedTracks.push(displayVideoTracks[0]);
        previewStreamRef.current = new MediaStream([displayVideoTracks[0]]);
      } else {
        previewStreamRef.current = null;
      }

      if (hasAudioSource) {
        combinedTracks.push(...dest.stream.getAudioTracks());
      }

      const combinedStream = new MediaStream(combinedTracks);

      const preferredTypes = recordingVideo
        ? [
            "video/webm;codecs=vp9,opus",
            "video/webm;codecs=vp8,opus",
            "video/webm",
          ]
        : [
            "audio/webm;codecs=opus",
            "audio/webm",
            "audio/mp4",
            "audio/ogg",
          ];

      const supportedMime =
        preferredTypes.find((t) => MediaRecorder.isTypeSupported(t)) || "";
      mimeRef.current =
        supportedMime || (recordingVideo ? "video/webm" : "audio/webm");

      const recorderOptions: MediaRecorderOptions = supportedMime
        ? {
            mimeType: supportedMime,
            ...(recordingVideo
              ? { videoBitsPerSecond: 650000, audioBitsPerSecond: 96000 }
              : { audioBitsPerSecond: 96000 }),
          }
        : {};

      const recorder = new MediaRecorder(combinedStream, recorderOptions);

      chunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeRef.current });
        const finalParticipants = whoRecordedRef.current;
        const finalSource = activeSourceLabelRef.current;
        cleanupStreams();
        if (blob.size < 1024) {
          setError(
            "Recording was empty. Please share tab audio or speak into your mic and try again."
          );
          setRecState("idle");
          setElapsed(0);
          return;
        }
        void submitRecordingForSummary(
          blob,
          mimeRef.current,
          effectivePlatform,
          finalParticipants,
          finalSource,
          recordingVideo
        );
      };

      [...displayVideoTracks, ...displayAudioTracks].forEach((track) => {
        track.onended = () => {
          if (recorderRef.current && recorderRef.current.state !== "inactive") {
            recorderRef.current.stop();
          }
        };
      });

      recorderRef.current = recorder;
      recorder.start(1000);
      setRecState("recording");
      setElapsed(0);
      onStatus(
        `Recording ${detectedSource} — informing participants: ${participantsLabel}.`
      );

      timerRef.current = window.setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const updateMeter = () => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
        const avg = sum / dataArray.length;
        setLevel(Math.min(100, Math.round((avg / 96) * 100)));
        rafRef.current = requestAnimationFrame(updateMeter);
      };
      rafRef.current = requestAnimationFrame(updateMeter);
    } catch (err) {
      cleanupStreams();
      const msg =
        err instanceof Error ? err.message : "Could not start live recording.";
      setError(msg);
      setRecState("idle");
    }
  };

  const togglePause = () => {
    const rec = recorderRef.current;
    if (!rec) return;
    if (rec.state === "recording") {
      rec.pause();
      if (timerRef.current !== null) {
        window.clearInterval(timerRef.current);
        timerRef.current = null;
      }
      setRecState("paused");
      onStatus(`Recording paused (${activeSourceLabel}).`);
    } else if (rec.state === "paused") {
      rec.resume();
      timerRef.current = window.setInterval(() => {
        setElapsed((prev) => prev + 1);
      }, 1000);
      setRecState("recording");
      onStatus(`Recording resumed — being recorded: ${whoRecorded}.`);
    }
  };

  const stopAndSummarize = () => {
    const rec = recorderRef.current;
    if (rec && rec.state !== "inactive") {
      rec.stop();
    }
  };

  const handleCopyNotice = () => {
    const msg = `Recording notice: "${activeSourceLabel || platformDisplayName(platform)}" is currently being recorded by KaryaSync (${whoRecorded}) to generate meeting notes.`;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(msg)
        .then(() => {
          setNoticeCopied(true);
          onStatus("Copied participant recording notice to clipboard.");
        })
        .catch(() => undefined);
    }
  };

  const handleVideoPick = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    setError("");
    onAttachVideoFile(file);
  };

  const busy =
    recState === "recording" ||
    recState === "paused" ||
    recState === "processing" ||
    isProcessingExternal;

  return (
    <div className="rec-box">
      <div className="rec-box-head">
        <h3 className="pane-subhead">Zoom / Meet / Webpage</h3>
        {recState === "recording" ? (
          <span className="rec">REC {formatDuration(elapsed)}</span>
        ) : recState === "paused" ? (
          <span className="rec-timer">PAUSED {formatDuration(elapsed)}</span>
        ) : (
          <span className="rec-badge">{TPL[template].label}</span>
        )}
      </div>

      {/* Platform Selector */}
      <label className="label-sm" htmlFor="call-platform">
        Source to record / attach
      </label>
      <select
        id="call-platform"
        className="f"
        value={platform}
        disabled={busy}
        onChange={(e) => {
          const next = e.target.value as CallPlatform;
          onChangePlatform(next);
          if (!whoEdited) {
            setWhoRecorded(defaultParticipantsLabel(next, includeMic));
          }
        }}
      >
        <option value="website">My Webpage (This Tab)</option>
        <option value="zoom">Zoom Meeting</option>
        <option value="meet">Google Meet</option>
        <option value="mic">Microphone Only</option>
      </select>

      {/* Live Recording Active Notice: Inform who is being recorded */}
      {(recState === "recording" || recState === "paused") && (
        <div className="rec-notice" role="status" aria-live="polite">
          <div className="rec-notice-head">
            <span>{recState === "paused" ? "PAUSED NOTICE" : "RECORDING NOTICE"}</span>
            <span>{formatDuration(elapsed)}</span>
          </div>
          <p>
            <b>Source:</b> {activeSourceLabel || platformDisplayName(platform)}
          </p>
          <p>
            <b>Being recorded:</b> {whoRecorded}
          </p>
          {hasRecordedVideo && (
            <video
              ref={previewVideoRef}
              className="rec-preview"
              autoPlay
              muted
              playsInline
            />
          )}
          <progress
            className="meter-progress"
            aria-label="Audio input level"
            max={100}
            value={recState === "paused" ? 0 : Math.max(4, level)}
          />
          <button
            type="button"
            className="btn g btn-xs btn-block mt-6"
            onClick={handleCopyNotice}
          >
            {noticeCopied ? "Notice copied for chat" : "Copy notice to inform participants"}
          </button>
        </div>
      )}

      {/* Idle controls: direct user-gesture triggers for getDisplayMedia */}
      {recState === "idle" && (
        <>
          <label className="label-sm" htmlFor="who-recorded">
            Who is being recorded (disclosure notice)
          </label>
          <input
            id="who-recorded"
            className="f"
            type="text"
            value={whoRecorded}
            disabled={busy}
            onChange={(e) => {
              setWhoEdited(true);
              setWhoRecorded(e.target.value);
            }}
            placeholder="e.g. Riya, Kabir, and Me"
          />

          {platform !== "mic" && (
            <>
              <label className="check-sm">
                <input
                  type="checkbox"
                  checked={captureVideo}
                  disabled={busy}
                  onChange={(e) => setCaptureVideo(e.target.checked)}
                />
                Record webpage / tab video + audio
              </label>
              <label className="check-sm">
                <input
                  type="checkbox"
                  checked={includeMic}
                  disabled={busy}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setIncludeMic(checked);
                    if (!whoEdited) {
                      setWhoRecorded(defaultParticipantsLabel(platform, checked));
                    }
                  }}
                />
                Record microphone as well
              </label>
            </>
          )}

          {/* Direct user click triggers getDisplayMedia immediately inside handler */}
          <button
            type="button"
            className="btn red btn-sm btn-block mt-6"
            disabled={busy}
            onClick={() =>
              void startRecording(
                platform === "mic"
                  ? "mic"
                  : platform === "website"
                  ? "webpage"
                  : "call"
              )
            }
          >
            {platform === "mic"
              ? "Record microphone"
              : platform === "website"
              ? "Record live webpage + mic"
              : "Record live Zoom / Meet"}
          </button>

          {platform !== "website" && (
            <button
              type="button"
              className="btn g btn-sm btn-block mt-6"
              disabled={busy}
              onClick={() => void startRecording("webpage")}
            >
              Record my webpage + mic
            </button>
          )}

          <button
            type="button"
            className="btn btn-sm btn-block mt-6"
            disabled={busy}
            onClick={() => void handleGrantZoomFolderAccess()}
          >
            Grant Zoom folder access
          </button>
          <input
            ref={folderFallbackRef}
            type="file"
            multiple
            hidden
            webkitdirectory=""
            onChange={handleFolderFallbackChange}
          />

          {zoomFiles.length > 0 && (
            <div className="access-list" aria-label="Discovered Zoom recordings">
              {zoomFiles.slice(0, 5).map((zf, idx) => (
                <div className="access-item" key={`${zf.name}-${idx}`}>
                  <span title={zf.name}>{zf.name}</span>
                  <button
                    type="button"
                    className="btn btn-xs"
                    disabled={busy}
                    onClick={() => {
                      onChangePlatform("zoom");
                      onChangeCallTitle(
                        zf.name.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ")
                      );
                      onAttachVideoFile(zf.file);
                    }}
                  >
                    Summarize
                  </button>
                </div>
              ))}
            </div>
          )}

          <input
            className="f mt-6"
            type="url"
            value={meetingLink}
            disabled={busy}
            onChange={(e) => onChangeMeetingLink(e.target.value)}
            placeholder="Paste video, Zoom, Meet or website URL"
            aria-label="Video, Zoom, Meet or website URL"
          />

          <input
            className="f"
            type="text"
            value={callTitle}
            disabled={busy}
            onChange={(e) => onChangeCallTitle(e.target.value)}
            placeholder={`Meeting title (e.g. ${TPL[template].label})`}
            aria-label="Meeting title"
          />

          {meetingLink.trim() && (
            <button
              type="button"
              className="btn g btn-sm btn-block mt-6"
              disabled={busy}
              onClick={() => onProcessVideoUrl(meetingLink.trim())}
            >
              {isProcessingExternal ? "Summarizing..." : "Summarize video URL"}
            </button>
          )}

          <label
            className={`btn g btn-sm btn-block mt-6${isProcessingExternal ? " disabled" : ""}`}
          >
            {isProcessingExternal ? "Processing video..." : "Attach video file"}
            <input
              type="file"
              accept="video/*,.mp4,.webm,.mov,.mkv,.avi,audio/*,.mp3,.wav,.m4a,.ogg"
              hidden
              disabled={busy}
              onChange={handleVideoPick}
            />
          </label>
        </>
      )}

      {(recState === "recording" || recState === "paused") && (
        <div className="row mt-6">
          <button
            type="button"
            className="btn g btn-sm"
            onClick={togglePause}
          >
            {recState === "paused" ? "Resume" : "Pause"}
          </button>
          <button
            type="button"
            className="btn btn-sm flex-1"
            onClick={stopAndSummarize}
          >
            Stop &amp; Summarize
          </button>
        </div>
      )}

      {recState === "processing" && (
        <p className="note mt-6">
          Gemini AI is transcribing the recording ({whoRecorded}) and generating{" "}
          {TPL[template].label} minutes...
        </p>
      )}

      {warning && <p className="rec-warn">{warning}</p>}
      {error && <p className="rec-err">{error}</p>}
    </div>
  );
};
