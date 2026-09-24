using { intake } from '../db/schema';

service AgentService {

  @readonly entity KnowledgeArticles as projection on intake.KnowledgeArticles;

  // Assignment 5: one row per run, holding the checkpoint written after every graph node.
  @readonly entity IntakeRuns as projection on intake.IntakeRuns;

  // Assignment 8: what a person released, and the audit trail of every human action.
  @readonly entity Outbox as projection on intake.Outbox;
  @readonly entity ApprovalEvents as projection on intake.ApprovalEvents;

  // Assignment 1: free-text question, free-text answer from the model.
  action askAgent(question : String) returns String;

  // Assignment 2: one model call, structured fields validated against srv/lib/schema.js.
  action triage(text : LargeString) returns TriageResponse;

  // Assignment 3: explicit state graph with deterministic policy checks in code.
  action runIntake(text : LargeString) returns IntakeRun;

  // Assignment 5: continue a run from its last checkpoint, e.g. after the process died.
  action resumeIntake(runID : UUID) returns IntakeRun;

  // Assignment 8: the approval gate. A run waits at 'awaiting_approval' until a person releases it.
  // `reason` is required when an edit changes a path that a code rule decided.
  @requires: 'approver'
  action editProposal(runID : UUID, path : String, owner : String, message : LargeString, reason : String) returns Approval;

  // Take a parked run out of the queue while you check something, and put it back.
  @requires: 'approver'
  action pauseRun(runID : UUID, reason : String) returns Approval;

  @requires: 'approver'
  action resumeRun(runID : UUID) returns Approval;

  // Approve: the run continues from the checkpoint and posts to the Outbox.
  @requires: 'approver'
  action approveRun(runID : UUID) returns IntakeRun;
}

type Approval {
  runID    : UUID;
  status   : String;       // awaiting_approval | on_hold
  proposal : LargeString;  // JSON
}

type Triage {
  summary         : String;
  requester       : String;
  affected_system : String;
  error_message   : String;
  users_affected  : Integer;
  missing_info    : many String;
  category        : String;
  urgency         : String;
  owner           : String;
  next_action     : String;
  kb_article_id   : String;
  confidence      : Double;
  policy_basis    : String;
}

type TriageResponse {
  valid     : Boolean;
  stage     : String;       // where validation failed: request | json_mode | parse | schema
  errors    : many String;
  result    : Triage;
  raw       : LargeString;  // raw model output, always returned so failures can be inspected
  model     : String;
  latencyMs : Integer;
}

type IntakeRun {
  runID      : UUID;
  status     : String;      // running | awaiting_approval | on_hold | completed | failed
  proposal   : LargeString; // JSON: what a person is asked to approve
  posted     : LargeString; // JSON: the Outbox row, once released
  path       : String;      // ask_for_info | draft_response | route_to_group | escalate_to_human
  owner      : String;
  reasons    : many String;
  overrides  : many { rule : String; modelSaid : String; codeDecided : String; };
  output     : LargeString; // the proposed message or handoff note
  extraction : LargeString; // JSON
  classification : LargeString; // JSON
  policy     : LargeString; // JSON
  invalidOutputs : many { node : String; attempt : Integer; stage : String; errors : many String; raw : LargeString; };
  trace      : many { node : String; next : String; ms : Integer; note : String; };
  modelCalls : Integer;
  modelLatencyMs : Integer;
  totalMs    : Integer;
}
