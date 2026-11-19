/* A storage-independent staff queue. The host supplies persistence via onSave. */
(function () {
  "use strict";

  let root = null;
  let callbacks = {};
  let records = [];
  let options = {};
  const drafts = new Map();
  const filters = { hostel: "all", category: "all", priority: "all", status: "all", attention: "all" };
  const statusOptions = ["Submitted", "Assigned", "In progress", "Resolved", "Closed"];

  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, character => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
    })[character]);
  }

  function formatVisit(value) {
    if (!value) return "Visit not scheduled";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString(undefined, {
      dateStyle: "medium", timeStyle: "short"
    });
  }

  function localInputValue(value) {
    if (!value) return "";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "";
    const pad = part => String(part).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }

  function uniqueValues(key) {
    return [...new Set(records.map(item => String(item[key] || "").trim()).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }

  function populateFilter(key, values, label) {
    const select = root.querySelector(`[data-queue-filter="${key}"]`);
    if (!values.includes(filters[key])) filters[key] = "all";
    select.innerHTML = `<option value="all">${label}</option>${values.map(value =>
      `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`
    ).join("")}`;
    select.value = filters[key];
  }

  function renderCards() {
    const openIds = new Set(Array.from(root.querySelectorAll(".sq-editor[open] .sq-form"), form => form.dataset.queueId));
    const query = String(options.search || "").trim().toLowerCase();
    const visible = records.filter(item => Object.keys(filters).every(key =>
      filters[key] === "all" || (key === "attention" ? (filters[key] === "escalated" ? item.escalated && item.status === "Submitted" : item.status === "Submitted" && !item.reviewedAt) : String(item[key] || "") === filters[key])
    ) && (!query || `${item.title} ${item.category} ${item.hostel} ${item.room} ${item.id} ${item.status} ${item.priority} ${item.assignee} ${item.description || ""} ${
      Array.isArray(item.messages) ? item.messages.map(message => typeof message === "string" ? message : message.text || "").join(" ") : ""
    }`.toLowerCase().includes(query))).map((item, index) => ({ item, index })).sort((a, b) =>
      Number(Boolean(b.item.escalated)) - Number(Boolean(a.item.escalated)) || Number(b.item.priority === "Urgent") - Number(a.item.priority === "Urgent") || a.index - b.index
    );
    const count = root.querySelector(".sq-count");
    count.textContent = `Showing ${visible.length} of ${records.length} ${records.length === 1 ? "report" : "reports"}`;
    const list = root.querySelector(".sq-list");
    if (!visible.length) {
      list.innerHTML = `<div class="sq-empty"><strong>${records.length ? "No matching reports" : "No reports in the queue"}</strong><p>${records.length ? "Try another search or filter to see more work." : "New maintenance reports will appear here."}</p></div>`;
      return;
    }
    list.innerHTML = visible.map(({ item }, index) => {
      const id = escapeHtml(item.id);
      const title = escapeHtml(item.title || "Untitled issue");
      const status = statusOptions.includes(item.status) ? item.status : "Submitted";
      const currentAssignee = item.assignee && item.assignee !== "Awaiting assignment" ? item.assignee : "";
      const currentPhone = item.assigneePhone || "";
      const technicians = Array.isArray(options.technicians) ? options.technicians : [];
      const visit = item.visitAt || item.visitTime || "";
      const fieldId = `sq-${index}`;
      return `<article class="sq-card">
        <div class="sq-card-heading"><div class="sq-title"><span class="sq-category-icon" aria-hidden="true">✦</span><div><strong>${title}</strong><small>${id} · ${escapeHtml(item.category || "Other")}</small></div></div><span class="sq-priority ${item.priority === "Urgent" ? "urgent" : ""}">${escapeHtml(item.priority || "Standard")}</span></div>
        ${item.escalated ? '<p class="sq-escalation"><strong>Escalated by student:</strong> ' + escapeHtml(item.reopenReason || "") + '</p>' : item.reopenReason ? '<p class="sq-escalation"><strong>Reopened:</strong> ' + escapeHtml(item.reopenReason) + '</p>' : ""}
        <div class="sq-meta"><span><b>Location</b>${escapeHtml(item.hostel || "—")} · ${escapeHtml(item.room || "—")}</span><span><b>Technician</b>${escapeHtml(currentAssignee || "Unassigned")}${currentPhone ? `<br><span class="sq-phone">${escapeHtml(currentPhone)}</span>` : ""}</span><span><b>Visit</b>${escapeHtml(formatVisit(visit))}</span><span><b>Status</b>${escapeHtml(status)}</span></div>
        ${status !== "Closed" ? '<details class="sq-editor"><summary>Manage report' : '<details class="sq-editor" hidden><summary>Manage report'} <span aria-hidden="true">⌄</span></summary>
          <form class="sq-form" data-queue-id="${id}" data-original-assignee="${escapeHtml(currentAssignee)}">
            <div class="sq-form-grid">
              <label for="${fieldId}-priority">Warden priority<select id="${fieldId}-priority" name="priority"><option ${item.priority === "Standard" ? "selected" : ""}>Standard</option><option ${item.priority === "Urgent" ? "selected" : ""}>Urgent</option></select></label>
              <label for="${fieldId}-assignee">Assign technician<select id="${fieldId}-assignee" name="assignee"><option value="">Unassigned</option>${technicians.map(technician => `<option value="${escapeHtml(technician.name)}" ${currentAssignee === technician.name ? "selected" : ""}>${escapeHtml(technician.name)}${technician.department ? ` · ${escapeHtml(technician.department)}` : ""}</option>`).join("")}${currentAssignee && !technicians.some(technician => technician.name === currentAssignee) ? `<option value="${escapeHtml(currentAssignee)}" selected>${escapeHtml(currentAssignee)} (existing assignment)</option>` : ""}</select></label>
              <label for="${fieldId}-phone">Technician phone<input id="${fieldId}-phone" name="assigneePhone" type="tel" inputmode="tel" autocomplete="off" value="${escapeHtml(currentPhone)}" maxlength="30" placeholder="e.g. +91 98765 43210" aria-describedby="${fieldId}-phone-help" /><span id="${fieldId}-phone-help">Optional; visible to the student.</span></label>
              <label for="${fieldId}-visit">Schedule visit<input id="${fieldId}-visit" name="visitAt" type="datetime-local" value="${escapeHtml(localInputValue(item.visitAt))}" /></label>
              <label for="${fieldId}-status">Status<select id="${fieldId}-status" name="status">${statusOptions.filter(value => value === status || (status === "Submitted" && value === "Assigned")).map(value => `<option value="${escapeHtml(value)}" ${status === value ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}</select></label>
            </div>
            <label for="${fieldId}-message">Update for the student <span>(optional)</span><textarea id="${fieldId}-message" name="message" rows="2" maxlength="500" placeholder="Add a note about the repair or visit"></textarea></label>
            <div class="sq-form-actions"><span class="sq-form-feedback" role="status" aria-live="polite"></span><button type="submit">Save update <span aria-hidden="true">→</span></button></div>
          </form>
        </details>
      </article>`;
    }).join("");
    list.querySelectorAll(".sq-form").forEach(form => {
      const draft = drafts.get(form.dataset.queueId);
      if (draft) Object.entries(draft).forEach(([name, value]) => {
        const field = form.elements[name];
        // A different staff member may have advanced the report while this draft was open.
        if (name === "status" && !Array.from(field.options).some(option => option.value === value)) return;
        field.value = value;
      });
      if (openIds.has(form.dataset.queueId)) form.closest(".sq-editor").open = true;
    });
  }

  function rememberDraft(form) {
    if (!form) return;
    const fields = ["assignee", "assigneePhone", "visitAt", "status", "message", "priority"];
    drafts.set(form.dataset.queueId, Object.fromEntries(fields.map(name => [name, form.elements[name].value])));
  }

  function render(nextRecords, nextOptions) {
    records = Array.isArray(nextRecords) ? nextRecords.slice() : [];
    options = nextOptions || {};
    if (!root) return;
    root.hidden = options.isStaff === false;
    if (root.hidden) return;
    // Live updates should not discard an unfinished assignment or message.
    if (root.querySelector(".sq-editor[open]")) return;
    populateFilter("hostel", uniqueValues("hostel"), "All hostels");
    populateFilter("category", uniqueValues("category"), "All categories");
    populateFilter("priority", ["Standard", "Urgent"], "All priorities");
    populateFilter("status", statusOptions, "All statuses");
    populateFilter("attention", ["needs-review", "escalated"], "All attention levels");
    root.querySelector('[data-queue-filter="attention"] option[value="needs-review"]').textContent = "Awaiting review";
    root.querySelector('[data-queue-filter="attention"] option[value="escalated"]').textContent = "Escalated";
    renderCards();
  }

  function mount(container, config) {
    if (!container) throw new Error("A container is required for the staff queue.");
    if (!config || typeof config.onSave !== "function") throw new Error("The staff queue needs an onSave callback.");
    if (root && root._staffQueueCleanup) root._staffQueueCleanup();
    root = container;
    drafts.clear();
    Object.keys(filters).forEach(key => { filters[key] = "all"; });
    callbacks = config;
    root.classList.add("staff-queue");
    root.innerHTML = `<div class="sq-heading"><div><span class="sq-kicker">WARDEN WORKSPACE</span><h2>Warden review queue</h2><p>Review complaints, set priorities, and assign registered technicians.</p></div><span class="sq-count" aria-live="polite"></span></div>
      <div class="sq-filters" aria-label="Filter the staff work queue">
        <label>Hostel<select data-queue-filter="hostel"></select></label>
        <label>Category<select data-queue-filter="category"></select></label>
        <label>Priority<select data-queue-filter="priority"></select></label>
        <label>Status<select data-queue-filter="status"></select></label>
        <label>Attention<select data-queue-filter="attention"></select></label>
      </div><div class="sq-list"></div>`;
    const onChange = event => {
      const key = event.target.dataset.queueFilter;
      if (!key || !(key in filters)) {
        rememberDraft(event.target.closest(".sq-form"));
        return;
      }
      filters[key] = event.target.value;
      renderCards();
    };
    const onSubmit = async event => {
      const form = event.target.closest(".sq-form");
      if (!form) return;
      event.preventDefault();
      const data = new FormData(form);
      const assignee = String(data.get("assignee") || "").trim();
      const assigneePhone = String(data.get("assigneePhone") || "").trim();
      const visitValue = String(data.get("visitAt") || "");
      const status = String(data.get("status") || "Submitted");
      const message = String(data.get("message") || "").trim();
      const priority = String(data.get("priority") || "Standard");
      const feedback = form.querySelector(".sq-form-feedback");
      const button = form.querySelector('button[type="submit"]');
      if (status !== "Submitted" && !assignee) {
        feedback.textContent = "Add a technician for this report status.";
        form.elements.assignee.focus();
        return;
      }
      if (assigneePhone && !assignee) {
        feedback.textContent = "Add the technician's name before entering a phone number.";
        form.elements.assignee.focus();
        return;
      }
      if (assigneePhone && (!/^\+?[0-9 ()-]+$/.test(assigneePhone) || assigneePhone.replace(/\D/g, "").length < 7 || assigneePhone.replace(/\D/g, "").length > 15)) {
        feedback.textContent = "Enter a valid phone number with 7 to 15 digits.";
        form.elements.assigneePhone.focus();
        return;
      }
      const date = visitValue ? new Date(visitValue) : null;
      if (date && Number.isNaN(date.getTime())) {
        feedback.textContent = "Choose a valid visit date and time.";
        form.elements.visitAt.focus();
        return;
      }
      button.disabled = true;
      feedback.textContent = "Saving update…";
      try {
        const saved = await callbacks.onSave(form.dataset.queueId, { assignee, assigneePhone, visitAt: date ? date.toISOString() : null, status, message, priority });
        if (saved === false) throw new Error("The update could not be saved.");
        drafts.delete(form.dataset.queueId);
        feedback.textContent = "Update saved.";
        form.elements.message.value = "";
        renderCards();
      } catch (error) {
        feedback.textContent = error && error.message ? error.message : "The update could not be saved. Please try again.";
      } finally {
        button.disabled = false;
      }
    };
    root.addEventListener("change", onChange);
    const onInput = event => {
      const form = event.target.closest(".sq-form");
      if (!form) return;
      if (event.target.name === "assignee" && event.target.value.trim() !== form.dataset.originalAssignee) {
        form.elements.assigneePhone.value = "";
      }
      rememberDraft(form);
    };
    root.addEventListener("input", onInput);
    root.addEventListener("submit", onSubmit);
    const onToggle = event => {
      if (event.target.classList.contains("sq-editor") && !event.target.open) render(records, options);
    };
    root.addEventListener("toggle", onToggle, true);
    root._staffQueueCleanup = () => {
      container.removeEventListener("change", onChange);
      container.removeEventListener("input", onInput);
      container.removeEventListener("submit", onSubmit);
      container.removeEventListener("toggle", onToggle, true);
      delete container._staffQueueCleanup;
    };
    render(records, config);
  }

  window.CampusCareStaffQueue = { mount, render };
}());
