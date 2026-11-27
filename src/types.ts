export type TemplateId = "general" | "standup" | "sales" | "one" | "board";

export type EngineMode = "rules" | "ai";

export type CallPlatform = "meet" | "zoom" | "website" | "mic";

export interface LiveRecordingInfo {
  active: boolean;
  paused: boolean;
  platform: CallPlatform;
  sourceLabel: string;
  recordedParticipants: string;
  elapsedSeconds: number;
  hasVideo: boolean;
}

export type WorkflowStage =
  | "idle"
  | "recording"
  | "uploading"
  | "transcribing"
  | "summarizing"
  | "done"
  | "error";

export interface DecisionItem {
  text: string;
  source: string;
}

export interface ActionItem {
  task: string;
  owner: string;
  deadline: string;
  source: string;
  done?: boolean;
}

export interface QuestionItem {
  text: string;
  source: string;
}

export interface MeetingMinutes {
  title: string;
  summary: string[];
  decisions: DecisionItem[];
  actions: ActionItem[];
  questions: QuestionItem[];
}

export interface SavedMeeting {
  id: number;
  title: string;
  notes: string;
  tpl: TemplateId;
  date?: string;
  platform?: CallPlatform;
  meetingLink?: string;
}

export interface ChatMessage {
  id: string;
  role: "u" | "b" | "n";
  text: string;
  typing?: boolean;
}
