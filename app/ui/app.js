// Service desk console over the intake agent. One page, no build step, no Component:
// sap.m controls created in code, talking to the CAP service with fetch.
sap.ui.getCore().attachInit(function () {
  "use strict"

  const API = "/odata/v4/agent"
  const PIPELINE = ["extract", "lookup_context", "classify", "check_policy", "choose_path"]
  const EXAMPLES = {
    "Locked account (a documented fix exists)":
      "Name: Oliver Grant\nLocation: Plant 1\nAffected system: Windows login\nDescription: Back from holiday and I forgot my password. After a few tries it says the account is locked.",
    "Production line stopped (P1)":
      "Caller: Jorge Alvarez, shift lead Plant 2. Packaging line 3 has stopped. The MES stations on the line show Server not responding.",
    "Too little information":
      "it's broken again. please fix asap!!!"
  }

  const model = new sap.ui.model.json.JSONModel({
    user: "lead", busy: false, nodes: [], queue: [], outbox: [], events: [],
    run: null, proposal: null, fields: [], overrides: []
  })

  // ---- service calls ---------------------------------------------------------------
  function auth() { return { Authorization: "Basic " + btoa(model.getProperty("/user") + ":") } }

  async function call(path, options) {
    const res = await fetch(API + path, {
      ...options,
      headers: { "Content-Type": "application/json", Accept: "application/json", ...auth(), ...(options || {}).headers }
    })
    const body = await res.text()
    let json = null
    try { json = body ? JSON.parse(body) : null } catch { /* keep raw */ }
    if (!res.ok) throw new Error(json?.error?.message || body || res.status + " " + res.statusText)
    return json
  }
  const post = (action, data) => call("/" + action, { method: "POST", body: JSON.stringify(data) })
  const read = path => call(path)

  function say(text, type) {
    const strip = sap.ui.getCore().byId("status")
    strip.setText(text).setType(type || "Information").setVisible(true)
  }

  // ---- node path -------------------------------------------------------------------
  function progressNodes(nextNode) {
    const at = PIPELINE.indexOf(nextNode)
    // A node outside the straight pipeline means the graph has branched: everything before it is done.
    const done = at === -1 ? PIPELINE : PIPELINE.slice(0, at)
    const list = done.map(n => ({ node: n, state: "done", note: "" }))
    list.push({ node: nextNode, state: "running", note: "running…" })
    model.setProperty("/nodes", list)
  }

  function traceNodes(trace) {
    model.setProperty("/nodes", trace.map(t => ({
      node: t.node === "resume" ? "(resumed here)" : t.node,
      state: "done",
      note: t.note || ""
    })))
  }

  // ---- rendering helpers -----------------------------------------------------------
  function showRun(run) {
    model.setProperty("/run", run)
    traceNodes(run.trace || [])
    const extraction = run.extraction ? JSON.parse(run.extraction) : null
    const classification = run.classification ? JSON.parse(run.classification) : null
    model.setProperty("/fields", [
      { k: "Decision", v: run.path + (run.owner ? " → " + run.owner : "") },
      { k: "Why", v: (run.reasons || []).join("; ") },
      { k: "Requester", v: extraction?.requester ?? "—" },
      { k: "Affected system", v: extraction?.affected_system ?? "—" },
      { k: "Urgency", v: classification?.urgency ?? "—" },
      { k: "Category", v: classification?.category ?? "—" },
      { k: "Model confidence", v: classification?.confidence ?? "—" }
    ])
    model.setProperty("/overrides", (run.overrides || []).map(o => ({
      text: o.rule, info: "model said " + o.modelSaid + ", code decided " + o.codeDecided
    })))
    model.setProperty("/proposal", run.proposal ? JSON.parse(run.proposal) : null)
    model.setProperty("/selectedRunID", run.runID)
    if (run.proposal) sap.ui.getCore().byId("message").setValue(JSON.parse(run.proposal).message)
  }

  async function refreshQueue() {
    const parked = await read("/IntakeRuns?$filter=status%20eq%20'awaiting_approval'%20or%20status%20eq%20'on_hold'&$select=ID,status,proposal,modifiedAt&$orderby=modifiedAt%20desc")
    model.setProperty("/queue", parked.value.map(r => {
      const p = r.proposal ? JSON.parse(r.proposal) : {}
      return { ID: r.ID, status: r.status, title: (p.path || "?") + " → " + (p.recipient || "?"), when: r.modifiedAt }
    }))
    const out = await read("/Outbox?$select=runID,path,channel,recipient,postedBy,createdAt&$orderby=createdAt%20desc&$top=10")
    model.setProperty("/outbox", out.value.map(o => ({
      title: o.channel + " → " + o.recipient, info: "released by " + o.postedBy, when: o.createdAt
    })))
  }

  async function loadEvents(runID) {
    const ev = await read("/ApprovalEvents?$filter=runID%20eq%20" + runID + "&$select=action,actor,reason,createdAt&$orderby=createdAt")
    model.setProperty("/events", ev.value.map(e => ({
      title: e.action, info: e.actor + (e.reason ? " — " + e.reason : "")
    })))
  }

  async function openRun(runID) {
    const r = await read("/IntakeRuns(" + runID + ")?$select=ID,status,proposal,state")
    const state = JSON.parse(r.state)
    showRun({
      runID: r.ID, status: r.status, proposal: r.proposal, trace: state.trace,
      path: state.decision.path, owner: state.decision.owner, reasons: state.decision.reasons,
      overrides: state.decision.overrides, extraction: JSON.stringify(state.extraction),
      classification: JSON.stringify(state.classification)
    })
    await loadEvents(runID)
  }

  // ---- actions ---------------------------------------------------------------------
  async function submit() {
    const text = sap.ui.getCore().byId("request").getValue().trim()
    if (!text) return say("Type a request first.", "Warning")
    model.setProperty("/busy", true)
    model.setProperty("/nodes", [])
    say("The agent is working…", "Information")

    // While the request runs, poll the run row: a checkpoint is written after every node.
    let polling = true
    const poll = async () => {
      while (polling) {
        try {
          const r = await read("/IntakeRuns?$filter=status%20eq%20'running'&$select=ID,nextNode&$orderby=createdAt%20desc&$top=1")
          if (r.value[0]) progressNodes(r.value[0].nextNode)
        } catch { /* the run may not exist yet */ }
        await new Promise(r => setTimeout(r, 500))
      }
    }
    poll()
    try {
      const run = await post("runIntake", { text })
      showRun(run)
      say(run.status === "awaiting_approval"
        ? "Parked: this needs a person before anything is sent."
        : "Posted straight away: " + (run.reasons || [])[0], run.status === "awaiting_approval" ? "Warning" : "Success")
      await refreshQueue()
      if (run.runID) await loadEvents(run.runID)
    } catch (e) {
      say(e.message, "Error")
    } finally {
      polling = false
      model.setProperty("/busy", false)
    }
  }

  async function act(action, extra) {
    const runID = model.getProperty("/selectedRunID")
    if (!runID) return say("Pick a run from the queue first.", "Warning")
    model.setProperty("/busy", true)
    try {
      const res = await post(action, { runID, ...extra })
      if (action === "approveRun") {
        showRun(res)
        const posted = res.posted ? JSON.parse(res.posted) : null
        say(posted ? "Released: " + posted.channel + " → " + posted.recipient + " (by " + posted.postedBy + ")" : "Approved.", "Success")
      } else {
        say(action + " ok — status is now " + res.status, "Success")
        if (res.proposal) model.setProperty("/proposal", JSON.parse(res.proposal))
      }
      await refreshQueue()
      await loadEvents(runID)
    } catch (e) {
      say(e.message, "Error")
    } finally {
      model.setProperty("/busy", false)
    }
  }

  // ---- layout ----------------------------------------------------------------------
  const nodeList = new sap.m.List({
    noDataText: "No run yet",
    items: { path: "/nodes", template: new sap.m.StandardListItem({
      title: "{node}", info: "{note}",
      icon: { path: "state", formatter: s => s === "done" ? "sap-icon://accept" : "sap-icon://pending" }
    }) }
  })

  const fieldList = new sap.m.List({
    items: { path: "/fields", template: new sap.m.DisplayListItem({ label: "{k}", value: "{v}" }) }
  })

  const overrideList = new sap.m.List({
    noDataText: "Code did not override the model on this request",
    items: { path: "/overrides", template: new sap.m.StandardListItem({ title: "{text}", info: "{info}", icon: "sap-icon://shield" }) }
  })

  const queueList = new sap.m.List({
    mode: "SingleSelectMaster",
    noDataText: "Nothing is waiting",
    selectionChange: e => openRun(e.getParameter("listItem").data("runID")).catch(err => say(err.message, "Error")),
    items: { path: "/queue", template: new sap.m.StandardListItem({
      title: "{title}", info: "{status}", description: "{when}",
      customData: [new sap.ui.core.CustomData({ key: "runID", value: "{ID}" })]
    }) }
  })

  const messageBox = new sap.m.TextArea("message", { rows: 5, width: "100%", growing: true })

  const proposalPanel = new sap.m.Panel({
    headerText: "What the agent proposes",
    content: [
      new sap.m.Text({ text: {
        parts: ["/proposal"], formatter: p => p ? p.channel + " → " + p.recipient + "   (" + p.path + ")" : "Pick a run from the queue, or send a request."
      } }).addStyleClass("sapUiTinyMarginBottom"),
      messageBox,
      new sap.m.HBox({ items: [
        new sap.m.Button({ text: "Save edit", icon: "sap-icon://edit", press: () => act("editProposal", { message: messageBox.getValue() }) }),
        new sap.m.Button({ text: "Hold", icon: "sap-icon://pause", press: () => act("pauseRun", { reason: "checking something" }) }),
        new sap.m.Button({ text: "Back to queue", icon: "sap-icon://play", press: () => act("resumeRun") }),
        new sap.m.Button({ text: "Approve & release", type: "Emphasized", icon: "sap-icon://accept", press: () => act("approveRun") })
      ] }).addStyleClass("sapUiSmallMarginTop")
    ]
  })

  const left = new sap.m.VBox({ width: "50%", items: [
    new sap.m.Panel({ headerText: "New request", content: [
      new sap.m.HBox({ items: Object.keys(EXAMPLES).map(label =>
        new sap.m.Button({ text: label, press: () => sap.ui.getCore().byId("request").setValue(EXAMPLES[label]) })
      ) }).addStyleClass("sapUiTinyMarginBottom"),
      new sap.m.TextArea("request", { rows: 5, width: "100%", placeholder: "Paste a service desk request…" }),
      new sap.m.Button({ text: "Send to the agent", type: "Emphasized", icon: "sap-icon://paper-plane", press: submit }).addStyleClass("sapUiSmallMarginTop")
    ] }),
    new sap.m.Panel({ headerText: "What the agent did, node by node", content: [nodeList] }),
    new sap.m.Panel({ headerText: "What it read from the request", content: [fieldList] }),
    new sap.m.Panel({ headerText: "Where code overruled the model", content: [overrideList] })
  ] })

  const right = new sap.m.VBox({ width: "50%", items: [
    new sap.m.Panel({ headerText: "Waiting for a person", content: [queueList] }),
    proposalPanel,
    new sap.m.Panel({ headerText: "Released (Outbox)", content: [new sap.m.List({
      noDataText: "Nothing has been released yet",
      items: { path: "/outbox", template: new sap.m.StandardListItem({ title: "{title}", info: "{info}", description: "{when}", icon: "sap-icon://outbox" }) }
    })] }),
    new sap.m.Panel({ headerText: "Who did what", content: [new sap.m.List({
      noDataText: "No history for this run",
      items: { path: "/events", template: new sap.m.StandardListItem({ title: "{title}", info: "{info}" }) }
    })] })
  ] })

  const page = new sap.m.Page({
    title: "Lumen Industrial — IT service desk console",
    busy: "{/busy}",
    headerContent: [
      new sap.m.Label({ text: "Signed in as" }),
      new sap.m.Select({
        selectedKey: "{/user}",
        items: [
          new sap.ui.core.Item({ key: "lead", text: "lead (may approve)" }),
          new sap.ui.core.Item({ key: "agent", text: "agent (may not approve)" })
        ]
      })
    ],
    content: [
      new sap.m.MessageStrip("status", { visible: false, showIcon: true }).addStyleClass("sapUiSmallMargin"),
      new sap.m.HBox({ items: [left, right], renderType: "Bare" })
    ]
  })

  page.setModel(model)
  new sap.m.App({ pages: [page] }).placeAt("content")
  refreshQueue().catch(e => say(e.message, "Error"))
})
