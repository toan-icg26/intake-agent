namespace intake;

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
