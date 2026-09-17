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
  status   : String(20);   // running | completed | failed
  nextNode : String(40);   // node to execute on resume; '__end__' when completed
  state    : LargeString;  // JSON snapshot of the graph state
  error    : LargeString;  // verbatim error text of the last failure
}
