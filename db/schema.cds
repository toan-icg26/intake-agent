namespace intake;

using { cuid, managed } from '@sap/cds/common';

/**
 * Documented resolutions the agent may use to draft a response.
 * All content is synthetic and written for this project.
 */
entity KnowledgeArticles {
  key ID         : String(10);
      title      : String(120);
      owner      : String(40);   // resolver group that maintains the article
      keywords   : String(500);  // comma-separated phrases matched against the request
      resolution : LargeString;
}

/**
 * One intake run and its latest checkpoint, written after every graph node
 * so a run can resume from nextNode after the process dies.
 */
entity IntakeRuns : cuid, managed {
  text     : LargeString;
  status   : String(20);   // running | awaiting_approval | on_hold | completed | failed
  nextNode : String(40);   // node to execute on resume; '__end__' when completed
  state    : LargeString;  // JSON snapshot of the graph state
  proposal : LargeString;  // JSON of what a person is asked to approve, so the queue is readable without the state
  error    : LargeString;  // verbatim error text of the last failure
}

/**
 * What actually left the system. Nothing is sent anywhere: posting writes a row here,
 * which is the system of record for "this action was released by a person".
 */
entity Outbox : cuid, managed {
  runID     : UUID;
  path      : String(20);
  channel   : String(30);   // reply_to_requester | handoff_to_group | page_duty_manager
  recipient : String(60);
  message   : LargeString;
  postedBy  : String(60);   // the approver, or 'code' when a code rule posted it without a gate
}

/** Audit trail of every human action on a run. */
entity ApprovalEvents : cuid, managed {
  runID  : UUID;
  action : String(20);      // parked | edited | paused | resumed | approved | posted
  actor  : String(60);
  reason : LargeString;
  before : LargeString;     // JSON proposal before an edit
  after  : LargeString;     // JSON proposal after an edit
}
