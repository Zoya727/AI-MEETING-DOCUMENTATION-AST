import "dotenv/config";
import express, { type Request, type Response } from "express";
import fs from "fs";
import multer from "multer";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { createPartFromUri, GoogleGenAI, Type } from "@google/genai";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

type TemplateId = "general" | "standup" | "sales" | "one" | "board";

const TEMPLATE_GUIDANCE: Record<TemplateId, { label: string; instructions: string }> = {
  general: {
    label: "General",
    instructions:
      "This is a general meeting. Summarize key discussion points, extract confirmed decisions, list action items with explicit owners and deadlines, and surface open questions.",
  },
  standup: {
    label: "Standup",
    instructions:
      "This is a daily standup. Summarize completed progress and today's plans concisely. Treat any blockers, missing access, or dependencies as open questions.",
  },
  sales: {
    label: "Sales call",
    instructions:
      "This is a sales call. Capture customer needs, pain points, budget/pricing discussions, objections, timeline, and concrete next steps. Put unapproved budgets or unclear sign-off authority into open questions.",
  },
  one: {
    label: "1:1",
    instructions:
      "This is a 1:1 meeting. Capture constructive feedback, career or sprint goals, workload/wellbeing observations, and mutual follow-ups per person.",
  },
  board: {
    label: "Board minutes",
    instructions:
      "These are formal board minutes. Capture formal resolutions, approved plans/budgets, audit or governance reports, deferred/tabled votes as open questions, and exact responsible officers or directors.",
  },
};

const ALLOWED_TEXT_MODELS = new Set(["gemini-4-hydrogen", "gemini-3.1-flash-lite"]);

const uploadDir = path.join(os.tmpdir(), "karyasync-uploads");
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

const upload = multer({
  dest: uploadDir,
  limits: {
    fileSize: 250 * 1024 * 1024, // Up to 250 MB video/audio recordings
  },
});

function inferMediaMimeType(originalName: string, providedMime: string): string {
  const clean = (providedMime || "").split(";")[0].trim().toLowerCase();
  if (clean && clean !== "application/octet-stream") {
    return clean;
  }
  const ext = path.extname(originalName || "").toLowerCase();
  const map: Record<string, string> = {
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".mov": "video/quicktime",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".m4v": "video/mp4",
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".m4a": "audio/mp4",
    ".ogg": "audio/ogg",
  };
  return map[ext] || "video/mp4";
}

function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is not configured. Please add your Gemini API key in the Settings > Secrets panel."
    );
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

function extractReadableErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw);
    if (parsed?.error?.message) return String(parsed.error.message);
    if (parsed?.message) return String(parsed.message);
  } catch {
    // Not raw JSON
  }
  return raw;
}

function isTransientHighDemand(err: unknown): boolean {
  const msg = extractReadableErrorMessage(err);
  return /503|UNAVAILABLE|high demand|overloaded|try again later/i.test(msg);
}

async function generateContentWithRetry(
  ai: GoogleGenAI,
  params: Parameters<GoogleGenAI["models"]["generateContent"]>[0]
) {
  const delays = [1200, 2500];
  let lastErr: unknown;

  for (let attempt = 0; attempt <= delays.length; attempt++) {
    try {
      return await ai.models.generateContent(params);
    } catch (err) {
      lastErr = err;
      if (!isTransientHighDemand(err) || attempt === delays.length) {
        break;
      }
      await new Promise((r) => setTimeout(r, delays[attempt]));
    }
  }

  // Fallback to gemini-3.1-flash-lite if primary model is temporarily experiencing 503 high demand
  if (
    isTransientHighDemand(lastErr) &&
    params.model !== "gemini-3.1-flash-lite" &&
    params.model !== "gemini-3.5-transcribe"
  ) {
    return await ai.models.generateContent({
      ...params,
      model: "gemini-3.1-flash-lite",
    });
  }

  throw lastErr;
}

function formatGeminiError(err: unknown): { status: number; message: string } {
  const msg = extractReadableErrorMessage(err);
  if (/API_KEY_INVALID|PERMISSION_DENIED|401|403/i.test(msg)) {
    return {
      status: 403,
      message:
        "Gemini API key was rejected or missing. Please verify GEMINI_API_KEY in Settings > Secrets.",
    };
  }
  if (/RESOURCE_EXHAUSTED|429/i.test(msg)) {
    return {
      status: 429,
      message:
        "Gemini API quota limit reached. Please wait a moment and try again, or check your billing quota in Settings > Secrets.",
    };
  }
  if (/503|UNAVAILABLE|high demand/i.test(msg)) {
    return {
      status: 503,
      message: `Gemini model is temporarily busy (${msg}). Please try again in a moment.`,
    };
  }
  if (/NOT_FOUND|404/i.test(msg)) {
    return {
      status: 404,
      message: `Requested Gemini model was not found or unavailable: ${msg}`,
    };
  }
  return { status: 500, message: msg || "Unexpected error calling Gemini API." };
}

const MINUTES_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    title: {
      type: Type.STRING,
      description: "Concise meeting title derived from the notes or call.",
    },
    summary: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description:
        "2 to 4 concise executive summary bullet points tailored to the meeting type.",
    },
    decisions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING, description: "Confirmed decision statement." },
          source: {
            type: Type.STRING,
            description: "Exact verbatim line from the notes supporting this decision.",
          },
        },
        required: ["text", "source"],
      },
    },
    actions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          task: { type: Type.STRING, description: "Actionable task description." },
          owner: {
            type: Type.STRING,
            description: 'Person responsible, or "Not specified" if missing.',
          },
          deadline: {
            type: Type.STRING,
            description: 'Due date or timeframe, or "Not specified" if missing.',
          },
          source: {
            type: Type.STRING,
            description: "Exact verbatim line from the notes supporting this action.",
          },
        },
        required: ["task", "owner", "deadline", "source"],
      },
    },
    questions: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          text: { type: Type.STRING, description: "Open question, blocker, tentative idea, or unresolved topic." },
          source: {
            type: Type.STRING,
            description: "Exact verbatim line from the notes supporting this item.",
          },
        },
        required: ["text", "source"],
      },
    },
  },
  required: ["title", "summary", "decisions", "actions", "questions"],
};

async function generateMinutesWithGemini(
  notes: string,
  template: TemplateId,
  modelName?: string,
  callTitleHint?: string
) {
  const ai = getGeminiClient();
  const tpl = TEMPLATE_GUIDANCE[template] || TEMPLATE_GUIDANCE.general;
  const model =
    modelName && ALLOWED_TEXT_MODELS.has(modelName)
      ? modelName
      : "gemini-4-hydrogen";

  const systemInstruction = [
    "Act as a meticulous technical meeting secretary.",
    tpl.instructions,
    "Use ONLY facts present in the provided notes/transcript; never invent names, dates, figures, or decisions.",
    'For every decision, action, and open question, set "source" to the exact verbatim sentence or line from the notes it came from.',
    "Only confirmed decisions go in decisions; tentative ideas, deferred items, blockers, or unconfirmed proposals go in questions.",
    'If an action owner or deadline is missing, write "Not specified".',
    callTitleHint
      ? `If the transcript has no explicit title line, use "${callTitleHint}" as the basis for the title.`
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  const response = await generateContentWithRetry(ai, {
    model,
    contents: notes,
    config: {
      systemInstruction,
      responseMimeType: "application/json",
      responseSchema: MINUTES_SCHEMA,
    },
  });

  const rawText = (response.text ?? "").replace(/```json|```/g, "").trim();
  if (!rawText) {
    throw new Error("Gemini returned an empty response when structuring minutes.");
  }

  const parsed = JSON.parse(rawText);
  return {
    title:
      typeof parsed.title === "string" && parsed.title.trim()
        ? parsed.title.trim()
        : callTitleHint || `${tpl.label} minutes`,
    summary: Array.isArray(parsed.summary) ? parsed.summary : [],
    decisions: Array.isArray(parsed.decisions) ? parsed.decisions : [],
    actions: Array.isArray(parsed.actions) ? parsed.actions : [],
    questions: Array.isArray(parsed.questions) ? parsed.questions : [],
  };
}

async function waitForGeminiFileActive(ai: GoogleGenAI, fileName: string) {
  const maxAttempts = 60; // Up to ~2 minutes
  for (let i = 0; i < maxAttempts; i++) {
    const fileInfo = await ai.files.get({ name: fileName });
    if (fileInfo.state === "ACTIVE") {
      return fileInfo;
    }
    if (fileInfo.state === "FAILED") {
      throw new Error(
        fileInfo.error?.message || "Gemini failed to process the uploaded video file."
      );
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  throw new Error("Timed out waiting for Gemini to process the uploaded video.");
}

async function startServer() {
  const app = express();
  app.use((_req, res, next) => {
    res.setHeader("Permissions-Policy", "display-capture=(self), microphone=(self)");
    next();
  });
  app.use(express.json({ limit: "50mb" }));

  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ ok: true, hasKey: Boolean(process.env.GEMINI_API_KEY) });
  });

  app.post("/api/gemini/minutes", async (req: Request, res: Response) => {
    try {
      const { notes, template = "general", model } = req.body ?? {};
      if (typeof notes !== "string" || !notes.trim()) {
        res.status(400).json({ error: "Meeting notes are required." });
        return;
      }
      const tplId = (template in TEMPLATE_GUIDANCE ? template : "general") as TemplateId;
      const minutes = await generateMinutesWithGemini(notes.trim(), tplId, model);
      res.json({ minutes });
    } catch (err) {
      const { status, message } = formatGeminiError(err);
      res.status(status).json({ error: message });
    }
  });

  app.post("/api/gemini/ask", async (req: Request, res: Response) => {
    try {
      const { notes, question, template = "general", model } = req.body ?? {};
      if (typeof notes !== "string" || !notes.trim()) {
        res.status(400).json({ error: "Meeting notes are required to answer questions." });
        return;
      }
      if (typeof question !== "string" || !question.trim()) {
        res.status(400).json({ error: "A question is required." });
        return;
      }
      const ai = getGeminiClient();
      const tpl =
        TEMPLATE_GUIDANCE[(template in TEMPLATE_GUIDANCE ? template : "general") as TemplateId];
      const selectedModel =
        typeof model === "string" && ALLOWED_TEXT_MODELS.has(model)
          ? model
          : "gemini-4-hydrogen";

      const response = await generateContentWithRetry(ai, {
        model: selectedModel,
        contents: `Meeting notes:\n${notes}\n\nQuestion:\n${question}`,
        config: {
          systemInstruction: `You are KaryaSync's meeting assistant for a ${tpl.label} meeting. Answer the user's question strictly using the provided meeting notes. Do not invent owners, deadlines, or decisions. If the answer is not in the notes, say so clearly and concisely.`,
        },
      });

      res.json({ answer: (response.text ?? "").trim() || "No response returned." });
    } catch (err) {
      const { status, message } = formatGeminiError(err);
      res.status(status).json({ error: message });
    }
  });

  // Upload a Zoom / Google Meet video or audio file via multipart/form-data
  app.post(
    "/api/gemini/process-video",
    upload.single("media"),
    async (req: Request, res: Response) => {
      const localPath = req.file?.path;
      let geminiFileName: string | undefined;

      try {
        if (!req.file || !localPath) {
          res.status(400).json({ error: "Please attach a Zoom or Google Meet video/audio file." });
          return;
        }

        const template = String(req.body?.template || "general");
        const platform = String(req.body?.platform || "zoom");
        const callTitle = String(req.body?.callTitle || "").trim();
        const meetingLink = String(req.body?.meetingLink || "").trim();
        const recordedParticipants = String(req.body?.recordedParticipants || "").trim();
        const sourceLabel = String(req.body?.sourceLabel || "").trim();
        const model = String(req.body?.model || "gemini-4-hydrogen");

        const tplId = (template in TEMPLATE_GUIDANCE ? template : "general") as TemplateId;
        const tpl = TEMPLATE_GUIDANCE[tplId];
        const mimeType = inferMediaMimeType(req.file.originalname, req.file.mimetype);
        const isAudioOnly = mimeType.startsWith("audio/");
        const selectedModel = ALLOWED_TEXT_MODELS.has(model)
          ? model
          : "gemini-4-hydrogen";

        const ai = getGeminiClient();

        const uploaded = await ai.files.upload({
          file: localPath,
          config: { mimeType },
        });
        geminiFileName = uploaded.name;

        const activeFile = uploaded.name
          ? await waitForGeminiFileActive(ai, uploaded.name)
          : uploaded;

        if (!activeFile.uri || !activeFile.mimeType) {
          throw new Error("Uploaded media file did not return a valid Gemini URI.");
        }

        const platformLabel =
          platform === "zoom"
            ? "Zoom meeting"
            : platform === "meet"
            ? "Google Meet call"
            : platform === "website"
            ? "Website / browser tab session"
            : "Recorded meeting";

        const transcribePrompt = [
          `Transcribe this ${platformLabel} (${tpl.label}) video/audio recording accurately.`,
          sourceLabel ? `Recorded tab/source: "${sourceLabel}".` : "",
          recordedParticipants
            ? `Participants/people being recorded: "${recordedParticipants}".`
            : "",
          "Identify speakers by name if spoken or visible on-screen (e.g., Zoom/Meet participant tiles or website captions), otherwise use Speaker 1, Speaker 2, etc.",
          "If participant names are audible or visible, start with a single line: 'Present: Name 1, Name 2.'",
          "Format the transcript cleanly one speaker turn or complete sentence per line (e.g., 'Riya: I will send the slides by Friday.').",
          "Also capture any decisive visual outcomes shown on shared slides/website/screen if clearly relevant to decisions or action items.",
          "Return ONLY the clean line-by-line transcript text with no markdown fences or extra commentary.",
        ]
          .filter(Boolean)
          .join(" ");

        // Use gemini-3.5-transcribe for pure audio if small/audio, or selected multimodal Gemini model for video
        const transcribeModel = isAudioOnly ? "gemini-3.5-transcribe" : selectedModel;

        const transcribeResponse = await generateContentWithRetry(ai, {
          model: transcribeModel,
          contents: {
            parts: [
              createPartFromUri(activeFile.uri, activeFile.mimeType),
              { text: transcribePrompt },
            ],
          },
        });

        const transcript = (transcribeResponse.text ?? "").trim();
        if (!transcript) {
          res.status(422).json({
            error:
              "No speech or meeting dialogue could be extracted from the attached video/audio.",
          });
          return;
        }

        const baseName = path.parse(req.file.originalname || "").name;
        const titleHint =
          callTitle ||
          (baseName && !/^recording/i.test(baseName)
            ? baseName.replace(/[_-]+/g, " ")
            : `${platformLabel} — ${tpl.label}`);

        const minutes = await generateMinutesWithGemini(
          transcript,
          tplId,
          selectedModel,
          titleHint
        );

        res.json({
          transcript,
          minutes,
          meetingLink,
          fileName: req.file.originalname,
        });
      } catch (err) {
        const { status, message } = formatGeminiError(err);
        res.status(status).json({ error: message });
      } finally {
        if (localPath && fs.existsSync(localPath)) {
          fs.unlink(localPath, () => undefined);
        }
        if (geminiFileName) {
          try {
            const ai = getGeminiClient();
            await ai.files.delete({ name: geminiFileName });
          } catch {
            // Ignore cleanup failure
          }
        }
      }
    }
  );

  // Process a YouTube or direct video URL (e.g., yesterday's Zoom call link)
  app.post("/api/gemini/process-video-url", async (req: Request, res: Response) => {
    let tempFilePath: string | undefined;
    let geminiFileName: string | undefined;

    try {
      const {
        videoUrl,
        template = "general",
        platform = "zoom",
        callTitle = "",
        model = "gemini-4-hydrogen",
      } = req.body ?? {};

      if (typeof videoUrl !== "string" || !videoUrl.trim()) {
        res.status(400).json({ error: "A valid video URL is required." });
        return;
      }

      const rawUrl = videoUrl.trim();
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(rawUrl);
      } catch {
        res.status(400).json({ error: "Invalid video URL format." });
        return;
      }

      if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
        res.status(400).json({ error: "Only HTTP/HTTPS video URLs are supported." });
        return;
      }

      const tplId = (template in TEMPLATE_GUIDANCE ? template : "general") as TemplateId;
      const tpl = TEMPLATE_GUIDANCE[tplId];
      const selectedModel = ALLOWED_TEXT_MODELS.has(model)
        ? model
        : "gemini-4-hydrogen";
      const platformLabel =
        platform === "zoom"
          ? "Zoom meeting"
          : platform === "meet"
          ? "Google Meet call"
          : "Recorded meeting";

      const ai = getGeminiClient();

      // Normalize YouTube links (youtu.be, youtube.com/watch, shorts, embed, live)
      let ytId = "";
      const host = parsedUrl.hostname.replace(/^www\./, "").toLowerCase();
      if (host === "youtu.be") {
        ytId = parsedUrl.pathname.replace(/^\//, "").split("/")[0] || "";
      } else if (host === "youtube.com" || host === "m.youtube.com") {
        if (parsedUrl.pathname === "/watch") {
          ytId = parsedUrl.searchParams.get("v") || "";
        } else {
          const m = parsedUrl.pathname.match(/^\/(?:shorts|embed|live)\/([^/?]+)/);
          if (m) ytId = m[1];
        }
      }

      const transcribePrompt = [
        `Transcribe this ${platformLabel} (${tpl.label}) video accurately.`,
        "Identify speakers by name if spoken or visible on-screen (e.g., Zoom/Meet participant tiles), otherwise use Speaker 1, Speaker 2, etc.",
        "If participant names are audible or visible, start with a single line: 'Present: Name 1, Name 2.'",
        "Format the transcript cleanly one speaker turn or complete sentence per line (e.g., 'Riya: I will send the slides by Friday.').",
        "Also capture any decisive visual outcomes shown on shared slides/screen if clearly relevant to decisions or action items.",
        "Return ONLY the clean line-by-line transcript text with no markdown fences or extra commentary.",
      ].join(" ");

      let videoPart;
      if (ytId) {
        const canonicalYoutubeUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(ytId)}`;
        videoPart = { fileData: { fileUri: canonicalYoutubeUrl } };
      } else {
        // Direct media URL download + Gemini Files API upload
        const dlRes = await fetch(rawUrl);
        if (!dlRes.ok) {
          throw new Error(`Could not fetch video URL (HTTP ${dlRes.status}).`);
        }
        const contentType = dlRes.headers.get("content-type") || "video/mp4";
        const buf = Buffer.from(await dlRes.arrayBuffer());
        tempFilePath = path.join(uploadDir, `url-${Date.now()}.mp4`);
        fs.writeFileSync(tempFilePath, buf);

        const mimeType = inferMediaMimeType(parsedUrl.pathname, contentType);
        const uploaded = await ai.files.upload({
          file: tempFilePath,
          config: { mimeType },
        });
        geminiFileName = uploaded.name;
        const activeFile = uploaded.name
          ? await waitForGeminiFileActive(ai, uploaded.name)
          : uploaded;

        if (!activeFile.uri || !activeFile.mimeType) {
          throw new Error("Uploaded video URL did not return a valid Gemini URI.");
        }
        videoPart = createPartFromUri(activeFile.uri, activeFile.mimeType);
      }

      const transcribeResponse = await generateContentWithRetry(ai, {
        model: selectedModel,
        contents: {
          parts: [videoPart, { text: transcribePrompt }],
        },
      });

      const transcript = (transcribeResponse.text ?? "").trim();
      if (!transcript) {
        res.status(422).json({
          error:
            "No speech or meeting dialogue could be extracted from the attached video URL.",
        });
        return;
      }

      const titleHint =
        typeof callTitle === "string" && callTitle.trim()
          ? callTitle.trim()
          : `${platformLabel} — ${tpl.label}`;

      const minutes = await generateMinutesWithGemini(
        transcript,
        tplId,
        selectedModel,
        titleHint
      );

      res.json({
        transcript,
        minutes,
        videoUrl: rawUrl,
      });
    } catch (err) {
      const { status, message } = formatGeminiError(err);
      res.status(status).json({ error: message });
    } finally {
      if (tempFilePath && fs.existsSync(tempFilePath)) {
        fs.unlink(tempFilePath, () => undefined);
      }
      if (geminiFileName) {
        try {
          const ai = getGeminiClient();
          await ai.files.delete({ name: geminiFileName });
        } catch {
          // Ignore cleanup failure
        }
      }
    }
  });

  // Live browser-recorded Zoom / Meet audio stream endpoint
  app.post("/api/gemini/record-summarize", async (req: Request, res: Response) => {
    try {
      const {
        audioBase64,
        mimeType = "audio/webm",
        template = "general",
        platform = "meet",
        callTitle = "",
        recordedParticipants = "",
        sourceLabel = "",
        model,
      } = req.body ?? {};

      if (typeof audioBase64 !== "string" || !audioBase64.trim()) {
        res.status(400).json({ error: "Recorded audio data is required." });
        return;
      }

      const tplId = (template in TEMPLATE_GUIDANCE ? template : "general") as TemplateId;
      const tpl = TEMPLATE_GUIDANCE[tplId];
      const platformLabel =
        platform === "zoom"
          ? "Zoom call"
          : platform === "meet"
          ? "Google Meet call"
          : platform === "website"
          ? "Website / browser tab session"
          : "Recorded meeting";

      const ai = getGeminiClient();

      const cleanMime = String(mimeType).split(";")[0].trim() || "audio/webm";
      const transcribePrompt = [
        `Transcribe this ${platformLabel} (${tpl.label}) accurately.`,
        sourceLabel ? `Recorded source/tab: "${sourceLabel}".` : "",
        recordedParticipants
          ? `Participants/people being recorded: "${recordedParticipants}".`
          : "",
        "Format the transcript as clean line-by-line dialogue with speaker labels on their own lines (for example: 'Speaker 1: ...' or the speaker's actual name if introduced in the call).",
        "Keep one complete sentence or speaker turn per line so each line can be referenced individually.",
        "If participant names are mentioned, include a first line like 'Present: Name 1, Name 2.' if clearly audible.",
        "Return only the clean transcript text without markdown fences or commentary.",
      ]
        .filter(Boolean)
        .join(" ");

      const transcribeResponse = await generateContentWithRetry(ai, {
        model: "gemini-3.5-transcribe",
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: cleanMime,
                data: audioBase64,
              },
            },
            { text: transcribePrompt },
          ],
        },
      });

      const transcript = (transcribeResponse.text ?? "").trim();
      if (!transcript) {
        res.status(422).json({
          error:
            "No speech was detected in the recording. Make sure tab audio or microphone input was active during the call.",
        });
        return;
      }

      const titleHint =
        typeof callTitle === "string" && callTitle.trim()
          ? callTitle.trim()
          : `${platformLabel} — ${tpl.label}`;

      const minutes = await generateMinutesWithGemini(
        transcript,
        tplId,
        model,
        titleHint
      );

      res.json({ transcript, minutes });
    } catch (err) {
      const { status, message } = formatGeminiError(err);
      res.status(status).json({ error: message });
    }
  });

  if (process.env.NODE_ENV !== "production") {
    const { createServer } = await import("vite");
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, "dist");
    app.use(express.static(distDir));
    app.get("*all", (_req: Request, res: Response) => {
      const indexFile = path.join(distDir, "index.html");
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send("Build output not found. Run npm run build first.");
      }
    });
  }

  const port = Number(process.env.PORT) || 3000;
  app.listen(port, "0.0.0.0", () => {
    console.log(`KaryaSync server running on http://0.0.0.0:${port}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
