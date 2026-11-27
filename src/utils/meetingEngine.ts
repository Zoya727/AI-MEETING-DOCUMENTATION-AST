import type { ActionItem, MeetingMinutes, SavedMeeting, TemplateId } from "../types";

export const NS = "Not specified";

export const TPL: Record<TemplateId, { label: string; promptHint: string; focus: string }> = {
  general: {
    label: "General",
    promptHint:
      "This is a general meeting. Summarize key topics covered, confirmed decisions, clear action items with owners and due dates, and open questions.",
    focus: "Balanced summary, decisions, owners & due dates.",
  },
  standup: {
    label: "Standup",
    promptHint:
      "This is a daily standup. Capture completed progress, planned work for today/tomorrow, and treat all blockers or missing access as open questions.",
    focus: "Progress, plans, and blockers as open questions.",
  },
  sales: {
    label: "Sales call",
    promptHint:
      "This is a sales call. Capture customer needs, pain points, objections, budget/pricing signals, timeline, stakeholder alignment, and concrete next steps in summary, decisions, actions, and questions.",
    focus: "Needs, objections, budget, timeline & next steps.",
  },
  one: {
    label: "1:1",
    promptHint:
      "This is a 1:1 meeting. Capture feedback, career or sprint goals, workload/wellbeing concerns, and follow-ups assigned per person.",
    focus: "Feedback, goals, workload & per-person follow-ups.",
  },
  board: {
    label: "Board minutes",
    promptHint:
      "These are formal board minutes. Capture formal resolutions, approved proposals, governance/audit items, deferred or unapproved votes as open questions, and responsible officers or directors.",
    focus: "Formal resolutions, approvals & responsible officers.",
  },
};

const DAYS =
  "today|tomorrow|tonight|eod|next week|this week|monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const DUE = new RegExp(`\\s*\\b(?:by |before |on )?(${DAYS})\\b`, "i");
const DEC = /\b(decided|agreed|going with|go with|approved|confirmed|settled)\b/i;
const NEG =
  /\b(no|not|nothing|without|yet)\b[^.]{0,25}\b(agreed|decided|confirmed|approved|settled)\b|\bcame up\b|\bto be decided\b/i;
const QS = /\?|\b(asked|wondered|unsure|not sure|maybe|perhaps|might|should we|could we)\b/i;
const ACT =
  /'ll|\bwill\b|\bneeds? to\b|\bto (?:book|send|share|prepare|review|finish|update|fix|write|schedule|email|call)\b/i;
const VAGUE = /^(someone|somebody|anyone|everyone|all|team|we|they)$/i;

export function cap(x: string): string {
  return x ? x.charAt(0).toUpperCase() + x.slice(1) : "";
}

export function sents(t: string): string[] {
  return t
    .split(/(?<=[.!?])\s+|\n+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

export function names(t: string): string[] {
  const m = t.match(/present:\s*([^\n]+)/i);
  if (m) {
    return m[1]
      .replace(/\./g, "")
      .split(/,|\band\b/)
      .map((n) => n.trim())
      .filter(Boolean);
  }
  const speakerSet = new Set<string>();
  for (const line of sents(t)) {
    const sp = line.match(/^([A-Z][a-zA-Z0-9 ._-]{1,24}):\s+/);
    if (sp && !/^(Present|Date|Note|Topic|Agenda|Summary)$/i.test(sp[1])) {
      speakerSet.add(sp[1].trim());
    }
  }
  return Array.from(speakerSet);
}

export function runRulesEngine(t: string): MeetingMinutes {
  const nm = names(t);
  const d: MeetingMinutes = {
    title: "Meeting minutes",
    summary: [],
    decisions: [],
    actions: [],
    questions: [],
  };

  sents(t).forEach((l, i) => {
    if (/^present:/i.test(l)) return;
    if (i === 0 && !(ACT.test(l) || DEC.test(l) || QS.test(l))) {
      d.title = l.replace(/\.$/, "");
      return;
    }
    const sp = l.match(/^([A-Z][a-zA-Z0-9 ._-]{1,24}):\s*(.*)$/);
    const b = sp ? sp[2] : l;
    if (QS.test(b) || NEG.test(b)) {
      d.questions.push({ text: b, source: l });
      return;
    }
    if (DEC.test(b)) {
      d.decisions.push({ text: b, source: l });
      return;
    }
    if (ACT.test(b)) {
      let o = NS;
      for (let k = 0; k < nm.length; k++) {
        if (new RegExp(`\\b${nm[k].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(b)) {
          o = nm[k];
          break;
        }
      }
      if (o === NS) {
        if (sp && /\b(i'll|i will|i can)\b/i.test(b)) {
          o = sp[1];
        } else {
          const w = b.match(/^([A-Z][a-z]+) (?:will|to|needs)/);
          if (w && !VAGUE.test(w[1])) o = w[1];
        }
      }
      const dm = b.match(DUE);
      const task = b
        .split(/'ll\s+|\bwill\s+|\bneeds? to\s+/i)
        .pop()!
        .replace(DUE, "")
        .replace(/[.\s]+$/, "");
      d.actions.push({
        task: cap(task),
        owner: o,
        deadline: dm ? cap(dm[1]) : NS,
        source: l,
      });
      return;
    }
    d.summary.push(b);
  });

  d.summary = d.summary.slice(0, 3);
  d.summary.push(
    `Recorded ${d.decisions.length} decision(s), ${d.actions.length} action item(s) and ${d.questions.length} open question(s).`
  );
  return d;
}

export function matchLine(a?: string, b?: string): boolean {
  return !!a && !!b && (a === b || a.indexOf(b) > -1 || b.indexOf(a) > -1);
}

export function lineType(line: string, cur: MeetingMinutes | null): "" | "d" | "a" | "q" {
  if (!cur) return "";
  if (cur.decisions.some((x) => matchLine(line, x.source))) return "d";
  if (cur.actions.some((x) => matchLine(line, x.source))) return "a";
  if (cur.questions.some((x) => matchLine(line, x.source))) return "q";
  return "";
}

export function findGaps(d: MeetingMinutes): ActionItem[] {
  return d.actions.filter(
    (a) => !a.owner || a.owner === NS || !a.deadline || a.deadline === NS
  );
}

export function formatTasksMarkdown(d: MeetingMinutes): string {
  return d.actions
    .map(
      (a) =>
        `- [${a.done ? "x" : " "}] ${a.task} (Owner: ${a.owner || NS}, Due: ${a.deadline || NS})`
    )
    .join("\n");
}

export function formatMarkdown(d: MeetingMinutes, dateStr: string): string {
  const L = [`# ${d.title}`, `Date: ${dateStr}`, "", "## Summary"];
  d.summary.forEach((x) => L.push(`- ${x}`));
  L.push("", "## Decisions");
  d.decisions.forEach((x) => L.push(`- ${x.text}`));
  if (!d.decisions.length) L.push("- None confirmed");
  L.push("", "## Action items", formatTasksMarkdown(d), "", "## Open questions");
  d.questions.forEach((x) => L.push(`- ${x.text}`));
  if (!d.questions.length) L.push("- None");
  L.push("", "_AI-assisted draft. Reviewed by a team member before sharing._");
  return L.join("\n");
}

export function formatSlack(d: MeetingMinutes): string {
  const L = [`*${d.title}*`];
  if (d.decisions.length) {
    L.push("", "*Decisions*");
    d.decisions.forEach((x) => L.push(`• ${x.text}`));
  }
  L.push("", "*Action items*");
  d.actions.forEach((a) =>
    L.push(`• ${a.owner || NS}: ${a.task} (${a.deadline || NS})`)
  );
  return L.join("\n");
}

export function formatCsv(d: MeetingMinutes): string {
  const q = (s: string) => `"${String(s || "").replace(/"/g, '""')}"`;
  return ["Task,Owner,Deadline,Done"]
    .concat(
      d.actions.map((a) =>
        [q(a.task), q(a.owner), q(a.deadline), a.done ? "yes" : "no"].join(",")
      )
    )
    .join("\n");
}

export function formatFollowUpEmail(d: MeetingMinutes): string {
  const L = [
    `Subject: Recap: ${d.title}`,
    "",
    "Hi team,",
    "",
    "Thanks for joining. Here is what we covered.",
  ];
  if (d.decisions.length) {
    L.push("", "Decisions:");
    d.decisions.forEach((x) => L.push(`- ${x.text}`));
  }
  if (d.actions.length) {
    L.push("", "Action items:");
    d.actions.forEach((a) =>
      L.push(
        `- ${a.owner && a.owner !== NS ? a.owner : "Owner to be assigned"}: ${a.task}${
          a.deadline && a.deadline !== NS
            ? ` (due ${a.deadline})`
            : " (date to be set)"
        }`
      )
    );
  }
  if (d.questions.length) {
    L.push("", "Still open:");
    d.questions.forEach((x) => L.push(`- ${x.text}`));
  }
  L.push("", "Please reply if anything here looks wrong.");
  return L.join("\n");
}

export function offlineAsk(q: string, cur: MeetingMinutes, notes: string): string {
  const l = q.toLowerCase();
  const li = (a: { text: string }[]) => a.map((x) => `- ${x.text}`).join("\n");
  if (/follow.?up|email/.test(l)) return formatFollowUpEmail(cur);
  if (/missing|no owner|without|gap/.test(l)) {
    const g = findGaps(cur);
    return g.length
      ? g
          .map(
            (a) =>
              `- ${a.task}: ${
                !a.owner || a.owner === NS ? "no owner" : `owner ${a.owner}`
              }, ${
                !a.deadline || a.deadline === NS
                  ? "no due date"
                  : `due ${a.deadline}`
              }`
          )
          .join("\n")
      : "Every action item has an owner and a due date.";
  }
  if (/who|owner|own\b|assign/.test(l)) {
    return cur.actions.length
      ? cur.actions
          .map(
            (a) =>
              `${a.owner && a.owner !== NS ? a.owner : "Unassigned"}: ${a.task} (${
                a.deadline || NS
              })`
          )
          .join("\n")
      : "No action items found.";
  }
  if (/open|unresolved|pending|question/.test(l)) {
    const u = cur.questions
      .map((x) => `- ${x.text}`)
      .concat(findGaps(cur).map((a) => `- Missing owner or date: ${a.task}`));
    return u.length ? u.join("\n") : "Nothing unresolved.";
  }
  if (/decid|decision/.test(l)) {
    return cur.decisions.length ? li(cur.decisions) : "No confirmed decisions.";
  }
  const w = l.split(/\W+/).filter((x) => x.length > 3);
  const hit = sents(notes).filter((s) =>
    w.some((x) => s.toLowerCase().indexOf(x) > -1)
  );
  return hit.length
    ? `Lines that mention it:\n${hit.join("\n")}`
    : "I could not find that in the notes. Switch to AI model mode for open-ended questions.";
}

const STORAGE_KEY = "ks_meetings";

export function loadSavedMeetings(): SavedMeeting[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as SavedMeeting[]) : [];
  } catch {
    return [];
  }
}

export function storeSavedMeetings(list: SavedMeeting[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.slice(0, 30)));
  } catch {
    // Ignore storage quota errors
  }
}
