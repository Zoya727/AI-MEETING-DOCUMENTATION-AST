import { useEffect, useState } from "react";
import { Workspace } from "./components/Workspace";
import type { ChatMessage, EngineMode, MeetingMinutes, TemplateId } from "./types";
import { TPL } from "./utils/meetingEngine";

export default function App() {
  const [heroTagged, setHeroTagged] = useState(false);
  const [tpl, setTpl] = useState<TemplateId>("general");
  const [notes, setNotes] = useState<string>("");
  const [mode, setMode] = useState<EngineMode>("ai");
  const [cur, setCur] = useState<MeetingMinutes | null>(null);
  const [statusMsg, setStatusMsg] = useState<string>(
    "Record live Zoom, Google Meet or any website (with permission notice), or attach a video."
  );
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    const id = window.setTimeout(() => setHeroTagged(true), 1500);
    return () => window.clearTimeout(id);
  }, []);

  const selectTemplateWorkflow = (nextTpl: TemplateId) => {
    setTpl(nextTpl);
    setMode("ai");
    setStatusMsg(
      `Template set to ${TPL[nextTpl].label}. Attach your Zoom or Google Meet video to generate minutes.`
    );
    document.getElementById("app")?.scrollIntoView({ behavior: "smooth" });
  };

  return (
    <>
      <nav className="bar" aria-label="Primary">
        <div className="wrap">
          <div className="brand">
            KARYA<i>SYNC</i>
          </div>
          <ul>
            <li>
              <a href="#workflow">Workflow</a>
            </li>
            <li>
              <a href="#templates">Templates</a>
            </li>
            <li>
              <a href="#app">Workspace</a>
            </li>
            <li>
              <a href="#privacy">Privacy</a>
            </li>
            <li>
              <a href="#exports">Exports</a>
            </li>
          </ul>
          <a className="btn" href="#app">
            Open workspace
          </a>
        </div>
      </nav>

      <header className="hero">
        <div className="dots" />
        <div className="beam" />
        <div className="wrap">
          <div className="slate">
            <b aria-hidden="true" />
            <span>AI Meeting Documentation Assistant</span>
          </div>
          <h1>
            Messy notes,<span>assigned</span> <em>tasks.</em>
          </h1>
          <div className="low">
            <div>
              <p className="tag">
                <b>
                  Turn Zoom and Google Meet videos or raw notes into decisions,
                  owners and due dates in seconds.
                </b>{" "}
                Every item links back to the line it came from.
              </p>
              <div className="cta">
                <a className="btn" href="#app">
                  Open workspace
                </a>
                <a className="btn g" href="#templates">
                  Pick a meeting type
                </a>
              </div>
            </div>

            <div
              className={`vf${heroTagged ? " tagged" : ""}`}
              id="pv"
              aria-label="Interactive preview"
            >
              <div className="vf-h">
                <span className="rec">Raw notes</span>
                <button
                  type="button"
                  className="btn btn-sm"
                  id="tg"
                  onClick={() => setHeroTagged((v) => !v)}
                >
                  Structure it
                </button>
              </div>
              <div className="ln">
                <b>Riya</b>I&apos;ll send the slides by Friday.
                <u className="u-a">Task · Riya · Fri</u>
              </div>
              <div className="ln">
                <b>All</b>Going with option B for the demo.
                <u className="u-d">Decision</u>
              </div>
              <div className="ln">
                <b>Sara</b>Who&apos;s running the live demo?
                <u className="u-q">Open question</u>
              </div>
            </div>
          </div>
        </div>
      </header>

      <section id="workflow">
        <div className="wrap">
          <p className="sc">Automated workflow</p>
          <h2>Attach, transcribe, summarize</h2>
          <div className="grid g3">
            <div className="box">
              <span className="pill">1. Record or Attach</span>
              <h3>Zoom, Meet or live website</h3>
              <p>
                Pick your meeting type, grant permission and inform participants
                who is being recorded across Zoom, Google Meet or any website
                tab, or attach a recording file.
              </p>
            </div>
            <div className="box">
              <span className="pill">2. Gemini AI</span>
              <h3>Automated extraction</h3>
              <p>
                In AI model mode, Gemini automatically transcribes speakers from
                your video and structures decisions, owners, due dates and open
                questions.
              </p>
            </div>
            <div className="box">
              <span className="pill">3. Export</span>
              <h3>Verify and share</h3>
              <p>
                Check flagged gaps against the source transcript line, edit in
                place, and export to Markdown, PDF, CSV, Slack, Notion, Jira or
                Email.
              </p>
            </div>
          </div>
          <div className="cta cta-workflow">
            <a className="btn" href="#app">
              Attach Zoom / Meet video
            </a>
            <span className="note note-inline">
              Supports .mp4, .webm, .mov, .mkv, audio files, and live call recording.
            </span>
          </div>
        </div>
      </section>

      <section id="templates">
        <div className="wrap">
          <p className="sc">Templates</p>
          <h2>Built for the meeting you have</h2>
          <p className="lead">
            Select a meeting template to configure the automated Gemini AI
            workflow for your Zoom or Google Meet recording.
          </p>
          <div className="grid g4">
            <div className={`box${tpl === "standup" ? " active-tpl" : ""}`}>
              <h3>Standup</h3>
              <p>Progress, plans and blockers as open questions.</p>
              <button
                type="button"
                className="btn g tp mt-10"
                onClick={() => selectTemplateWorkflow("standup")}
              >
                Use template
              </button>
            </div>
            <div className={`box${tpl === "sales" ? " active-tpl" : ""}`}>
              <h3>Sales call</h3>
              <p>Needs, objections, budget and next steps.</p>
              <button
                type="button"
                className="btn g tp mt-10"
                onClick={() => selectTemplateWorkflow("sales")}
              >
                Use template
              </button>
            </div>
            <div className={`box${tpl === "one" ? " active-tpl" : ""}`}>
              <h3>1:1</h3>
              <p>Feedback, goals and follow-ups per person.</p>
              <button
                type="button"
                className="btn g tp mt-10"
                onClick={() => selectTemplateWorkflow("one")}
              >
                Use template
              </button>
            </div>
            <div className={`box${tpl === "board" ? " active-tpl" : ""}`}>
              <h3>Board minutes</h3>
              <p>Formal decisions and who is responsible.</p>
              <button
                type="button"
                className="btn g tp mt-10"
                onClick={() => selectTemplateWorkflow("board")}
              >
                Use template
              </button>
            </div>
          </div>
        </div>
      </section>

      <Workspace
        tpl={tpl}
        notes={notes}
        mode={mode}
        cur={cur}
        statusMsg={statusMsg}
        chatMessages={chatMessages}
        onChangeTpl={setTpl}
        onChangeNotes={setNotes}
        onChangeMode={setMode}
        onChangeCur={setCur}
        onStatus={setStatusMsg}
        onAddChatMessage={(msg) => setChatMessages((prev) => [...prev, msg])}
      />

      <section id="privacy">
        <div className="wrap">
          <p className="sc">Privacy and trust</p>
          <h2>What happens to your notes</h2>
          <div className="grid g3">
            <div className="box">
              <h3>Offline option</h3>
              <p>
                In offline mode, typed notes are processed in your browser. Saved
                meetings stay in this browser&apos;s local storage, and nothing is
                uploaded.
              </p>
            </div>
            <div className="box">
              <h3>Gemini AI workflow</h3>
              <p>
                In AI model mode or when attaching a Zoom/Meet video, media is
                processed via this app&apos;s server with Google Gemini and
                deleted after extraction.
              </p>
            </div>
            <div className="box">
              <h3>Human review first</h3>
              <p>
                Exports unlock only after you confirm you checked the minutes
                against the source transcript.
              </p>
            </div>
          </div>
          <p className="code">
            <b>Compliance:</b> this is a project prototype. It holds no SOC 2 or
            GDPR certification and has no accounts, server-side database or
            audit logs, so it should not be used for confidential or regulated
            recordings. Those controls would be required before real client use.
          </p>
        </div>
      </section>

      <section id="exports">
        <div className="wrap">
          <p className="sc">Exports and integrations</p>
          <h2>Get the work out of the notes</h2>
          <div className="grid g2">
            <div className="box">
              <span className="pill">Works today</span>
              <h3>Ready-to-paste &amp; live capture</h3>
              <ul>
                <li>Permission-based live Zoom, Google Meet &amp; website tab capture</li>
                <li>Clear live notice informing participants who is being recorded</li>
                <li>Automated Gemini AI summaries tailored by meeting template</li>
                <li>Markdown, CSV, PDF, Slack, Jira/Linear, Notion &amp; Email</li>
              </ul>
            </div>
            <div className="box">
              <span className="pill">Planned, not built</span>
              <h3>Direct connections</h3>
              <ul>
                <li>Unattended Zoom, Google Meet and Teams calendar bots</li>
                <li>Calendar connection</li>
                <li>One-click push to Slack, Notion, Jira, Linear and CRMs</li>
                <li>Real-time team editing and comments</li>
              </ul>
            </div>
          </div>
        </div>
      </section>

      <footer>
        <div className="wrap">
          KaryaSync · AI Meeting Documentation Assistant · Powered by Gemini AI
          under human review.
        </div>
      </footer>
      <a className="top" href="#" aria-label="Back to top">
        TOP
      </a>
    </>
  );
}
