const accounts = [
  { id: "aarav", type: "student", name: "Aarav Sharma", initials: "AS", hostel: "BH-2", room: "Room 304", studentId: "SAMPLE2024", email: "aarav.7f31@demo.lpu", role: "Student · BH-2" },
  { id: "priya", type: "student", name: "Priya Verma", initials: "PV", hostel: "GH-1", room: "Room 108", studentId: "SAMPLE2025", email: "priya.4a82@demo.lpu", role: "Student · GH-1" },
  { id: "staff-rk", type: "staff", name: "R. Kumar", initials: "RK", staffId: "STAFF004", email: "rk.electrical.91@demo.lpu", department: "Electrical", role: "Electrician · Electrical" }
];
accounts.push({ id: "warden", type: "staff", name: "Hostel Warden", initials: "HW", staffId: "WARDEN001", email: "warden@demo.lpu", department: "Residential services", role: "Hostel Warden" });
const demoPassword = "campus123";
const supportEmail = "info@lpu.co.in";
const preferenceStoragePrefix = "campuscare-preferences-";
let currentAccount = null;
let complaints = [];
let notifications = [];
let technicians = [];
let isTechnician = false;
let isWarden = false;
let loginType = "student";
let activeFilter = "all";
let query = "";
let activeDetailId = null;
let toastTimer;
let pollTimer;
let selectedPhoto = null;
let photoReadVersion = 0;
let photoLoading = false;
let notificationsLoaded = false;
let sessionVersion = 0;
let refreshSequence = 0;
let lastAppliedRefresh = 0;
const pendingDetailActions = new Set();

const list = document.getElementById("complaint-list");
const drawer = document.getElementById("detail-drawer");
const drawerBackdrop = document.getElementById("drawer-backdrop");
const toast = document.getElementById("toast");
const iconByCategory = { Electrical: "⌁", Plumbing: "⌇", Carpentry: "▤", Cleaning: "✳", Other: "✦" };

async function apiRequest(path, options = {}) {
  const headers = { ...(options.body === undefined ? {} : { "Content-Type": "application/json" }), ...options.headers };
  const response = await fetch(path, {
    ...options,
    headers,
    credentials: "same-origin",
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  let result = {};
  try {
    result = await response.json();
  } catch (error) {
    if (response.ok) throw new Error("The server returned an invalid response.");
  }
  if (!response.ok) {
    const error = new Error(result.error || `Request failed (${response.status}).`);
    error.status = response.status;
    throw error;
  }
  return result;
}

function backendHelpMessage(error) {
  if (location.protocol === "file:" || error instanceof TypeError || error.status === 404 || error.status === 405) {
    return "Sign-in needs the CampusCare backend. Run `node server.js` in the project folder, then open http://127.0.0.1:3000/ (not Live Server or file://).";
  }
  return error.message || "The CampusCare server is unavailable. Start server.js and try again.";
}

function formatDate(value, options = {}) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: options.dateOnly ? undefined : "short"
  });
}

async function loadComplaints() {
  const result = await apiRequest("/api/complaints");
  if (!Array.isArray(result.complaints)) throw new Error("The server returned an invalid report list.");
  return result.complaints;
}

async function loadNotifications() {
  const result = await apiRequest("/api/notifications");
  if (!Array.isArray(result.notifications)) throw new Error("The server returned invalid notifications.");
  return result.notifications;
}

function getPreferences(account, type) {
  const defaults = type === "staff"
    ? { newRoomAlerts: true, showResolved: false }
    : { complaintUpdates: true, resolutionReminders: true };
  try {
    const saved = localStorage.getItem(`${preferenceStoragePrefix}${account.id}`);
    return saved ? { ...defaults, ...JSON.parse(saved) } : defaults;
  } catch (error) {
    console.error(`Could not load preferences for ${account.id}:`, error);
    return defaults;
  }
}

function savePreference(key, value) {
  const account = currentAccount;
  if (!account) return;
  const preferences = getPreferences(account, account.type);
  preferences[key] = value;
  try {
    localStorage.setItem(`${preferenceStoragePrefix}${account.id}`, JSON.stringify(preferences));
  } catch (error) {
    console.error("Could not save account preferences:", error);
    showToast("Your preference could not be saved.");
  }
  if (key === "showResolved") render();
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
}

function renderNotifications() {
  const unreadCount = notifications.filter(notification => !notification.read).length;
  const badge = document.getElementById("notification-badge");
  const button = document.getElementById("notification-button");
  badge.hidden = unreadCount === 0;
  badge.textContent = unreadCount > 9 ? "9+" : String(unreadCount);
  button.setAttribute("aria-label", unreadCount ? `Notifications, ${unreadCount} unread` : "Notifications");
  document.getElementById("mark-notifications-read").disabled = unreadCount === 0;
  document.getElementById("notification-empty").hidden = notifications.length > 0;
  document.getElementById("notification-list").innerHTML = notifications.map(notification => `
    <button type="button" class="notification-item ${notification.read ? "" : "unread"}"
      data-notification-id="${escapeHtml(notification.id)}" data-complaint-id="${escapeHtml(notification.complaintId)}">
      <span class="notification-item-icon">✉</span>
      <span class="notification-item-copy">
        <strong>${escapeHtml(notification.title)}</strong>
        <small>Maintenance team · ${escapeHtml(formatDate(notification.createdAt))} · ${escapeHtml(notification.complaintId)}</small>
        <p>${escapeHtml(notification.message)}</p>
      </span>
    </button>`).join("");
}

async function markNotificationsRead(notificationId) {
  const version = sessionVersion;
  try {
    await apiRequest("/api/notifications/read", {
      method: "POST",
      body: notificationId ? { ids: [notificationId] } : {}
    });
    const nextNotifications = await loadNotifications();
    if (version !== sessionVersion) return false;
    notifications = nextNotifications;
    renderNotifications();
    return true;
  } catch (error) {
    if (version !== sessionVersion) return false;
    console.error("Could not update notification status:", error);
    showToast(error.message || "Notification status could not be saved.");
    return false;
  }
}

async function refreshAppData(silent = false) {
  if (!currentAccount) return;
  const version = sessionVersion;
  const sequence = ++refreshSequence;
  try {
    const [nextComplaints, nextNotifications, technicianResult] = await Promise.all([loadComplaints(), loadNotifications(), isWarden ? apiRequest("/api/technicians") : Promise.resolve({ technicians: [] })]);
    if (version !== sessionVersion || sequence < lastAppliedRefresh) return;
    lastAppliedRefresh = sequence;
    const initialLoad = !notificationsLoaded;
    const previousNotificationIds = new Set(notifications.map(notification => notification.id));
    const hasNewNotification = notificationsLoaded && nextNotifications.some(notification => !notification.read && !previousNotificationIds.has(notification.id));
    const complaintsChanged = nextComplaints.length !== complaints.length || nextComplaints.some(next => {
      const current = complaints.find(item => item.id === next.id);
      return !current || current.updatedAt !== next.updatedAt;
    });
    const notificationsChanged = nextNotifications.length !== notifications.length || nextNotifications.some(next => {
      const current = notifications.find(item => item.id === next.id);
      return !current || current.read !== next.read;
    });
    const techniciansChanged = JSON.stringify(technicians) !== JSON.stringify(technicianResult.technicians);
    technicians = technicianResult.technicians;
    complaints = nextComplaints;
    notifications = nextNotifications;
    notificationsLoaded = true;
    if (initialLoad || complaintsChanged || notificationsChanged || techniciansChanged) {
      render();
      if (activeDetailId) {
        const activeItem = complaints.find(item => item.id === activeDetailId);
        if (activeItem) renderDetails(activeItem, { preserveDraft: true });
        else closeDetails();
      }
    }
    if (hasNewNotification) showToast("A maintenance update was posted.");
  } catch (error) {
    if (version !== sessionVersion || sequence < lastAppliedRefresh) return;
    console.error("Could not refresh reports and notifications:", error);
    if (error.status === 401) {
      clearSessionState();
      showToast("Your session expired. Please sign in again.");
      return;
    }
    if (!silent) showToast(error.message || "Reports could not be loaded.");
  }
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[character]);
}

function statusClass(status) {
  if (status === "Resolved" || status === "Closed") return "resolved";
  if (status === "In progress") return "progress";
  if (status === "Assigned") return "assigned";
  return "submitted";
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 12 ? "Good morning" : hour < 17 ? "Good afternoon" : "Good evening";
}

function render() {
  renderRoleOverview();
  const staffPreferences = isTechnician ? getPreferences(currentAccount, "staff") : { showResolved: false };
  const baseComplaints = isTechnician && !staffPreferences.showResolved && !["Resolved", "Closed"].includes(activeFilter)
    ? complaints.filter(item => !["Resolved", "Closed"].includes(item.status))
    : complaints;
  const filtered = baseComplaints.filter(item => {
    const matchesStatus = activeFilter === "all" || item.status === activeFilter;
    const messages = Array.isArray(item.messages) ? item.messages.map(message =>
      typeof message === "string" ? message : message.text || ""
    ).join(" ") : "";
    const searchable = `${item.title} ${item.category} ${item.hostel} ${item.room} ${item.id} ${item.status} ${item.priority} ${item.assignee} ${item.description || ""} ${messages}`.toLowerCase();
    return matchesStatus && searchable.includes(query.toLowerCase());
  });
  list.innerHTML = filtered.map(item => `
    <article class="complaint-row" data-id="${escapeHtml(item.id)}" data-deletable="${!isTechnician && item.status === "Submitted"}" tabindex="0" role="group" aria-label="Complaint: ${escapeHtml(item.title)}">
      <div class="issue-cell">
        <span class="issue-icon ${escapeHtml(item.category.toLowerCase())}">${escapeHtml(item.icon || iconByCategory[item.category] || "✦")}</span>
        <span class="issue-copy"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.id)} · ${escapeHtml(item.category)}${item.priority === "Urgent" ? " · <b style='color:#b24c36'>Urgent</b>" : ""}</small></span>
      </div>
      <div class="location-cell">${escapeHtml(item.hostel)}<small>${escapeHtml(item.room)}</small>${isTechnician ? `<small class="visit-time">${escapeHtml(item.visitAt ? formatDate(item.visitAt) : item.visitTime || (item.status === "Submitted" ? "Awaiting dispatch" : "Time to be confirmed"))}</small>` : ""}</div>
      <div><span class="status-chip ${statusClass(item.status)}">${escapeHtml(item.status)}</span></div>
      <div class="update-cell">${escapeHtml(formatDate(item.updatedAt || item.updated))}</div><span class="row-arrow">›</span>
      ${!isTechnician && item.status === "Submitted" ? `<button type="button" class="complaint-delete" aria-label="Delete submitted complaint ${escapeHtml(item.id)}" title="Delete submitted complaint">Delete</button>` : ""}
    </article>`).join("");
  document.getElementById("empty-state").hidden = filtered.length !== 0;
  document.querySelector(".empty-state strong").textContent = complaints.length ? "No reports found" : "No reports yet";
  document.querySelector(".empty-state p").textContent = complaints.length ? "Try adjusting your search or filters." : isWarden ? "New complaints will appear here for review." : isTechnician ? "Your assigned maintenance jobs will appear here." : "Report a hostel issue and your updates will appear here.";
  document.getElementById("list-count").textContent = String(baseComplaints.length).padStart(2, "0");
  document.getElementById("nav-count").textContent = complaints.filter(item => !["Resolved", "Closed"].includes(item.status)).length;
  document.getElementById("stat-total").innerHTML = `${String(complaints.length).padStart(2, "0")} <span class="stat-trend">total</span>`;
  document.getElementById("stat-progress").innerHTML = `${String(complaints.filter(item => item.status === "In progress" || item.status === "Assigned").length).padStart(2, "0")} <span class="stat-trend">being worked on</span>`;
  document.getElementById("stat-resolved").innerHTML = `${String(complaints.filter(item => ["Resolved", "Closed"].includes(item.status)).length).padStart(2, "0")} <span class="stat-trend">issue fixed</span>`;
  document.getElementById("stat-submitted").textContent = String(complaints.filter(item => item.status === "Submitted").length).padStart(2, "0");
  const openCount = complaints.filter(item => !["Resolved", "Closed"].includes(item.status)).length;
  const featured = complaints.filter(item => !["Resolved", "Closed"].includes(item.status))
    .sort((a, b) => new Date(b.createdAt || b.created || 0) - new Date(a.createdAt || a.created || 0))[0] || complaints[0];
  document.getElementById("hero-open-count").textContent = String(openCount).padStart(2, "0");
  document.getElementById("hero-open-label").textContent = isTechnician ? (openCount === 1 ? "open job" : "open jobs") : (openCount === 1 ? "open request" : "open requests");
  document.getElementById("hero-focus-label").textContent = featured && featured.status === "Resolved" ? "LATEST REPORT" : isTechnician ? "LATEST ACTIVE JOB" : "LATEST ACTIVE ISSUE";
  document.getElementById("hero-focus-title").textContent = featured ? featured.title : "No requests yet";
  const focusStatus = document.getElementById("hero-focus-status");
  focusStatus.hidden = !featured;
  focusStatus.textContent = featured ? featured.status : "";
  focusStatus.className = `status-chip ${statusClass(featured ? featured.status : "Submitted")}`;
  document.getElementById("hero-focus-meta").textContent = featured
    ? `${featured.hostel}, ${featured.room} · Technician: ${featured.assignee && featured.assignee !== "Awaiting assignment" ? featured.assignee : "Not assigned"}`
    : "Your updates will appear here";
  document.getElementById("hero-focus-visit").textContent = featured
    ? `Expected visit: ${featured.visitAt ? formatDate(featured.visitAt) : featured.status === "Resolved" ? "Completed" : featured.visitTime || "Not scheduled"}`
    : "";
  const focusButton = document.getElementById("hero-focus-button");
  focusButton.disabled = !featured;
  focusButton.dataset.id = featured ? featured.id : "";
  document.getElementById("footer-count").textContent = `Showing ${filtered.length} of ${baseComplaints.length} ${isTechnician ? "visits" : "reports"}`;
  document.getElementById("list-title").innerHTML = `${isWarden ? "All complaints" : isTechnician ? "Your assigned jobs" : "Your complaints"} <span class="list-count" id="list-count">${String(baseComplaints.length).padStart(2, "0")}</span>`;
  document.getElementById("list-kicker").textContent = isWarden ? "ALL HOSTEL REQUESTS" : isTechnician ? "YOUR MAINTENANCE JOBS" : "THE FOLLOW-THROUGH";
  document.getElementById("status-filter").options[0].textContent = isTechnician
    ? staffPreferences.showResolved ? "All visits" : "All open visits"
    : "All statuses";
  document.getElementById("complaints-nav-label").textContent = isWarden ? "All complaints" : isTechnician ? "My jobs" : "My complaints";
  document.getElementById("location-heading").textContent = isTechnician ? "ROOM / VISIT" : "LOCATION";
  document.getElementById("issue-heading").textContent = isTechnician ? "JOB" : "ISSUE";
  document.getElementById("show-all-button").innerHTML = isTechnician ? "View all active visits <span>→</span>" : "View all reports <span>→</span>";
  document.getElementById("app-shell").classList.toggle("staff-view", isTechnician);
  document.querySelectorAll(".complaint-row").forEach(row => {
    row.addEventListener("click", event => {
      if (event.target.closest(".complaint-delete")) return;
      openDetails(row.dataset.id);
    });
    row.addEventListener("keydown", event => {
      if (event.target.closest(".complaint-delete")) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openDetails(row.dataset.id); }
    });
  });
  document.querySelectorAll(".complaint-delete").forEach(button => {
    button.addEventListener("click", event => {
      event.stopPropagation();
      deleteComplaint(button.closest(".complaint-row").dataset.id, button);
    });
  });
  renderUpdates();
  renderNotifications();
  renderDashboard(featured);
  if (window.CampusCareStaffQueue) {
    window.CampusCareStaffQueue.render(complaints, { isStaff: isWarden, search: query, technicians });
  }
}

function renderRoleOverview() {
  const root = document.getElementById("role-overview");
  root.hidden = !isTechnician;
  if (!isTechnician) { root.innerHTML = ""; return; }
  const count = predicate => complaints.filter(predicate).length;
  const metrics = isWarden ? [
    ["Awaiting review", count(item => item.status === "Submitted" && !item.reviewedAt), "needs-review"],
    ["Escalated", count(item => item.escalated && item.status === "Submitted"), "escalated"],
    ["In progress", count(item => item.status === "In progress"), "progress"],
    ["Awaiting confirmation", count(item => item.status === "Resolved"), "resolved"]
  ] : [
    ["Assigned to you", count(item => item.status === "Assigned"), "assigned"],
    ["In progress", count(item => item.status === "In progress"), "progress"],
    ["Awaiting confirmation", count(item => item.status === "Resolved"), "resolved"],
    ["Completed", count(item => item.status === "Closed"), "closed"]
  ];
  root.innerHTML = `<div class="role-overview-heading"><div><span>${isWarden ? "RESIDENTIAL SERVICES" : "MAINTENANCE TEAM"}</span><h2>${isWarden ? "Warden dashboard" : "Technician dashboard"}</h2><p>${isWarden ? "Review requests, prioritize urgent work, and coordinate your team." : "Your assigned work, repair progress, and completed jobs in one place."}</p></div><button type="button" class="role-primary" data-role-action="${isWarden ? "queue" : "assigned"}">${isWarden ? "Open review queue" : "View assigned jobs"}</button></div><div class="role-metrics">${metrics.map(([label, value, action]) => `<button type="button" class="role-metric" data-role-action="${action}"><span>${label}</span><strong>${String(value).padStart(2, "0")}</strong><small>View ${isWarden ? "complaints" : "jobs"}</small></button>`).join("")}</div>`;
}

async function deleteComplaint(id, button) {
  const item = complaints.find(entry => entry.id === id);
  if (!item || isTechnician || item.status !== "Submitted") return;
  if (!window.confirm(`Delete your submitted complaint "${item.title}" (${item.id})? This cannot be undone.`)) return;

  button.disabled = true;
  try {
    await apiRequest(`/api/complaints/${encodeURIComponent(id)}`, { method: "DELETE" });
    complaints = complaints.filter(entry => entry.id !== id);
    if (activeDetailId === id) closeDetails();
    render();
    showToast("Complaint deleted.");
  } catch (error) {
    console.error(`Could not delete complaint ${id}:`, error);
    showToast(error.message || "Complaint could not be deleted.");
    button.disabled = false;
  }
}

function renderDashboard(featured) {
  const stages = [
    { label: "Submitted", icon: "▤" },
    { label: "Assigned", icon: "●" },
    { label: "In progress", icon: "✦" },
    { label: "Resolved", icon: "✓" }
  ];
  const activeIndex = featured ? Math.max(0, stages.findIndex(stage => stage.label === (featured.status === "Closed" ? "Resolved" : featured.status))) : -1;
  const events = featured && Array.isArray(featured.timeline) ? featured.timeline : [];
  document.getElementById("tracking-steps").innerHTML = stages.map((stage, index) => {
    const state = index < activeIndex ? "complete" : index === activeIndex ? "current" : "";
    const time = events[index] && events[index].time ? formatDate(events[index].time) : "";
    return `<div class="tracking-step ${state}"><span class="tracking-step-icon">${stage.icon}</span><strong>${stage.label}</strong><small>${escapeHtml(time)}</small></div>`;
  }).join("");
  const recent = document.getElementById("dashboard-recent");
  recent.innerHTML = complaints.slice(0, 3).map(item => `
    <button type="button" class="recent-item" data-recent-id="${escapeHtml(item.id)}">
      <span class="recent-dot ${statusClass(item.status)}"></span><span><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.status)} · ${escapeHtml(item.id)}</small></span><time>${escapeHtml(formatDate(item.updatedAt || item.updated))}</time>
    </button>`).join("") || '<p class="recent-empty">Updates will appear here when you have reports.</p>';
}

function updateMessage(item) {
  const room = `${item.hostel}, ${item.room}`;
  if (item.status === "Resolved") return `The technician marked this report resolved. Please confirm the repair or request another review.`;
  if (item.status === "Closed") return `You confirmed this repair and closed the complaint.`;
  if (item.status === "Submitted") return "Your report has been received. We’ll share the assigned technician and visit time here.";
  if (item.status === "In progress" && item.visitTime === "Visit in progress") return `${item.assignee || "Your technician"} is working on this issue in ${room}.`;
  if (item.visitAt) return `${item.assignee || "Your technician"} is expected at ${room} on ${formatDate(item.visitAt)}.`;
  if (item.status === "Assigned" || item.status === "In progress") {
    return `${item.assignee || "A technician"} is assigned to ${room}. The visit time is being confirmed.`;
  }
  return "We’ll post a new update as soon as the team checks this report.";
}

function renderUpdates() {
  const updatesList = document.getElementById("updates-list");
  if (!updatesList) return;
  const ordered = [...complaints].sort((a, b) => {
    if (a.status === "Resolved" && b.status !== "Resolved") return 1;
    if (b.status === "Resolved" && a.status !== "Resolved") return -1;
    return 0;
  });
  updatesList.innerHTML = ordered.map(item => `
    <article class="update-card">
      <div class="update-card-rail"><span class="update-symbol ${statusClass(item.status)}">${item.status === "Resolved" ? "✓" : item.status === "Submitted" ? "◷" : "↗"}</span><span class="update-rail-line"></span></div>
      <div class="update-card-body">
        <div class="update-card-meta"><span class="status-chip ${statusClass(item.status)}">${escapeHtml(item.status)}</span><span>${escapeHtml(formatDate(item.updatedAt || item.updated))}</span></div>
        <h3>${escapeHtml(item.title)}</h3>
        <p>${escapeHtml(updateMessage(item))}</p>
        <button type="button" class="update-view-button" data-update-id="${escapeHtml(item.id)}">View report <span>→</span></button>
      </div>
    </article>`).join("");
  document.getElementById("updates-empty").hidden = complaints.length > 0;
  updatesList.hidden = complaints.length === 0;
  updatesList.querySelectorAll("[data-update-id]").forEach(button => {
    button.addEventListener("click", () => openDetails(button.dataset.updateId));
  });
}

function updateGmailLink() {
  if (!currentAccount) return;
  const related = complaints.find(item => item.id === document.getElementById("support-related-report").value);
  const subject = document.getElementById("support-subject").value.trim() || "CampusCare maintenance support";
  const identityLabel = currentAccount.type === "staff" ? "Staff ID" : "Student ID";
  const identityValue = currentAccount.staffId || currentAccount.studentId;
  const accountDetails = [
    `Name: ${currentAccount.name}`,
    `${identityLabel}: ${identityValue}`,
    `Email: ${currentAccount.email}`,
    currentAccount.type === "staff"
      ? `Role: ${currentAccount.role} · ${currentAccount.department}`
      : `Hostel / room: ${currentAccount.hostel} · ${currentAccount.room}`
  ];
  const reportDetails = related ? [
    "",
    `Related complaint: ${related.id} — ${related.title}`,
    `Status: ${related.status}`,
    `Location: ${related.hostel} · ${related.room}`,
    `Issue details: ${related.description || "No additional details provided."}`
  ] : [];
  const message = [
    "Hello LPU Support,",
    "",
    "My account details:",
    ...accountDetails,
    ...reportDetails,
    "",
    "Message:",
    document.getElementById("support-message").value.trim()
  ].join("\n");
  const url = new URL("https://mail.google.com/mail/");
  url.searchParams.set("view", "cm");
  url.searchParams.set("fs", "1");
  url.searchParams.set("to", supportEmail);
  url.searchParams.set("su", subject);
  url.searchParams.set("body", message);
  document.getElementById("gmail-compose").href = url.toString();
}

function openHelp() {
  document.getElementById("help-overlay").hidden = false;
}

function openContact() {
  const relatedSelect = document.getElementById("support-related-report");
  relatedSelect.innerHTML = `<option value="">General question</option>${complaints.map(item =>
    `<option value="${escapeHtml(item.id)}">${escapeHtml(item.id)} · ${escapeHtml(item.title)}</option>`
  ).join("")}`;
  document.getElementById("support-subject").value = "CampusCare maintenance support";
  document.getElementById("support-message").value = "";
  document.getElementById("support-email-address").textContent = supportEmail;
  updateGmailLink();
  document.getElementById("contact-overlay").hidden = false;
}

function renderDetails(item, { preserveDraft = false } = {}) {
  const content = document.getElementById("drawer-content");
  const focused = preserveDraft && content.contains(document.activeElement) ? document.activeElement : null;
  const draft = preserveDraft ? {
    message: document.getElementById("staff-message-input")?.value,
    feedback: document.getElementById("feedback-text")?.value,
    completionDetails: document.getElementById("completion-details")?.value,
    decisionReason: document.getElementById("decision-reason")?.value,
    completionPhoto: document.getElementById("completion-photo"),
    rating: Number(content.querySelector('.rating-star[aria-pressed="true"]')?.dataset.rating || 0),
    focusId: focused?.id,
    selectionStart: focused && typeof focused.selectionStart === "number" ? focused.selectionStart : null,
    selectionEnd: focused && typeof focused.selectionEnd === "number" ? focused.selectionEnd : null
  } : null;
  const shownRating = draft && draft.rating ? draft.rating : item.rating || 0;
  const currentIndex = ["Resolved", "Closed"].includes(item.status) ? 3 : item.status === "In progress" ? 2 : item.status === "Assigned" ? 1 : 0;
  const events = item.timeline || [];
  const messages = Array.isArray(item.messages) ? item.messages : [];
  const assigned = Boolean(item.assignee && item.assignee !== "Awaiting assignment");
  const phone = typeof item.assigneePhone === "string" ? item.assigneePhone.trim() : "";
  const phoneLink = phone.replace(/[^\d+]/g, "");
  const photos = Array.isArray(item.photos) ? item.photos : [];
  content.innerHTML = `
    <div class="detail-topline">${isTechnician ? "MAINTENANCE TICKET" : "COMPLAINT DETAILS"} · ${escapeHtml(item.id)}</div>
    <div class="detail-heading"><span class="issue-icon ${escapeHtml(item.category.toLowerCase())}">${escapeHtml(item.icon || iconByCategory[item.category] || "✦")}</span><div><h2>${escapeHtml(item.title)}</h2><p>${escapeHtml(item.category)} · ${escapeHtml(item.priority)} priority</p></div></div>
    <div class="detail-status"><span class="status-chip ${statusClass(item.status)}">${escapeHtml(item.status)}</span><p>${item.status === "Closed" ? "The student confirmed the repair and closed this complaint." : item.status === "Resolved" ? "The technician marked this issue resolved. The student can confirm or request another review." : item.status === "In progress" ? "A technician is working on this. We’ll keep this page updated." : item.status === "Assigned" ? "A technician has been assigned and will share a visit time." : "Your report is awaiting warden review and assignment."}</p></div>
    <div class="report-contact-grid">
      <section class="reported-card"><span class="detail-card-label">WHAT YOU REPORTED</span><p>${escapeHtml(item.description || "No extra details were added to this report.")}</p></section>
      <section class="technician-card"><span class="detail-card-label">TECHNICIAN</span>${assigned ? `<strong>${escapeHtml(item.assignee)}</strong><small>Maintenance team</small>${phone && phoneLink ? `<a class="technician-phone" href="tel:${escapeHtml(phoneLink)}" aria-label="Call ${escapeHtml(item.assignee)} at ${escapeHtml(phone)}">${escapeHtml(phone)}</a>` : `<small>Phone number not provided</small>`}` : `<strong>Not assigned yet</strong><small>Contact details will appear after assignment.</small>`}</section>
    </div>
    ${photos.length ? `<div class="report-photos" aria-label="Attached photos">${photos.map((photo, index) => `<img src="${escapeHtml(photo.dataUrl)}" alt="Photo ${index + 1} attached to ${escapeHtml(item.title)}" />`).join("")}</div>` : ""}
    ${item.reviewedAt ? `<p class="lifecycle-note">Reviewed by ${escapeHtml(item.reviewedBy || "warden")} on ${escapeHtml(formatDate(item.reviewedAt))}.</p>` : item.status === "Submitted" ? '<p class="lifecycle-note">Awaiting warden review and assignment.</p>' : ""}
    ${item.reopenReason ? `<p class="lifecycle-note"><strong>${item.escalated ? "Escalated" : "Reopened"}:</strong> ${escapeHtml(item.reopenReason)}</p>` : ""}
    ${item.resolution ? `<section class="lifecycle-card"><strong>Completion details</strong><p>${escapeHtml(item.resolution.details)}</p><small>${escapeHtml(item.resolution.completedBy || "Technician")} · ${escapeHtml(formatDate(item.resolution.completedAt))}</small>${(item.resolution.photos || []).length ? `<div class="report-photos">${item.resolution.photos.map(photo => `<img src="${escapeHtml(photo.dataUrl)}" alt="Repair completion photo" />`).join("")}</div>` : ""}</section>` : ""}
    <div class="detail-section-title">PROGRESS UPDATES</div>
    <div class="timeline">${events.map((event, index) => {
      const state = event.complete || (item.status === "Resolved" && index <= 3) || index < currentIndex ? "complete" : event.current || index === currentIndex ? "current" : "";
      return `<div class="timeline-item ${state}"><span class="timeline-dot"></span><strong>${escapeHtml(event.title)}</strong><small>${escapeHtml(formatDate(event.time))}</small><p>${escapeHtml(event.detail || "")}</p></div>`;
    }).join("")}</div>
    <section class="message-section">
      <div class="detail-section-title">MESSAGE HISTORY</div>
      <div class="message-thread">${messages.length ? messages.map(message => `
        <article class="message-bubble">
          <strong>${escapeHtml(message.sender || "Maintenance team")}</strong>
          <time>${escapeHtml(formatDate(message.createdAt || message.time))}</time>
          <p>${escapeHtml(message.text)}</p>
        </article>`).join("") : `<p class="message-empty">${isTechnician ? "No messages sent yet." : "The maintenance team hasn’t sent a message yet."}</p>`}</div>
      ${isTechnician ? `<form class="staff-message-form" id="staff-message-form">
        <label for="staff-message-input">Send an update to the student</label>
        <textarea id="staff-message-input" maxlength="300" placeholder="Write a message about this report..." required></textarea>
        <button type="submit">Send message</button>
      </form>` : ""}
    </section>
    <div class="detail-info"><div><span>LOCATION</span><strong>${escapeHtml(item.hostel)} · ${escapeHtml(item.room)}</strong></div><div><span>ASSIGNED TO</span><strong>${escapeHtml(item.assignee || "Awaiting assignment")}</strong></div><div><span>VISIT TIME</span><strong>${escapeHtml(item.visitAt ? formatDate(item.visitAt) : item.visitTime || "Not scheduled")}</strong></div><div><span>REPORTED</span><strong>${escapeHtml(formatDate(item.createdAt || item.created))}</strong></div><div><span>LAST UPDATE</span><strong>${escapeHtml(formatDate(item.updatedAt || item.updated))}</strong></div></div>
    ${!isTechnician && ["Resolved", "Closed"].includes(item.status) ? `<section class="feedback-card"><div class="feedback-title"><strong>How did we do?</strong><span>YOUR FEEDBACK</span></div><p>Rate the repair and leave a note for the hostel team.</p><div class="feedback-stars" role="group" aria-label="Rate your repair">${[1, 2, 3, 4, 5].map(rating => `<button type="button" class="rating-star ${shownRating >= rating ? "selected" : ""}" data-rating="${rating}" aria-label="${rating} star${rating === 1 ? "" : "s"}" aria-pressed="${shownRating === rating}">★</button>`).join("")}</div><textarea id="feedback-text" maxlength="300" placeholder="Share a little feedback (optional)...">${escapeHtml(draft && draft.feedback !== undefined ? draft.feedback : item.feedback || "")}</textarea><button type="button" class="feedback-submit" id="feedback-submit">${item.rating ? "Update feedback" : "Send feedback"} <span>→</span></button></section>` : ""}
    ${!isTechnician && item.status === "Resolved" ? `<section class="lifecycle-card"><strong>Has the issue been fixed?</strong><p>Confirm closure, or explain what still needs attention.</p><label for="decision-reason">Reason for reopening or escalation</label><textarea id="decision-reason" maxlength="500" placeholder="Describe what is still wrong"></textarea><div class="decision-actions"><button type="button" data-decision="close">Yes, close complaint</button><button type="button" data-decision="reopen">Reopen</button><button type="button" data-decision="escalate">Escalate to warden</button></div></section>` : ""}
    ${isTechnician && !isWarden && item.status === "In progress" ? `<section class="lifecycle-card"><label for="completion-details">Completion details (required)</label><textarea id="completion-details" maxlength="1000" placeholder="Describe the completed repair"></textarea><label for="completion-photo">Completion photo (optional)</label><input id="completion-photo" type="file" accept="image/jpeg,image/png,image/webp"><small>JPEG, PNG or WebP, up to 5 MB.</small></section>` : ""}
    ${isTechnician && !isWarden && ["Assigned", "In progress"].includes(item.status) ? `<button class="primary-button tech-action" id="advance-ticket">${item.status === "Assigned" ? "Start repair" : "Mark as resolved"}</button>` : ""}
    ${isTechnician && item.status === "Resolved" ? `<button class="tech-action primary-button" disabled style="opacity:.65">Ticket complete ✓</button>` : ""}`;
  content.querySelectorAll("[data-decision]").forEach(button => button.addEventListener("click", async () => {
    const decision = button.dataset.decision;
    const reason = document.getElementById("decision-reason").value.trim();
    if (decision !== "close" && !reason) { showToast("Please explain what still needs attention."); return; }
    const action = `decision:${item.id}`;
    if (pendingDetailActions.has(action)) return;
    pendingDetailActions.add(action);
    const version = sessionVersion;
    content.querySelectorAll("[data-decision]").forEach(control => control.disabled = true);
    try {
      const result = await apiRequest(`/api/complaints/${encodeURIComponent(item.id)}/decision`, { method: "POST", body: { decision, reason } });
      if (version !== sessionVersion) return;
      Object.assign(item, result.complaint);
      render(); if (activeDetailId === item.id) renderDetails(item);
      showToast(decision === "close" ? "Complaint closed." : "Sent back to the warden for review.");
    } catch (error) {
      if (version === sessionVersion) { showToast(error.message || "Could not save your decision."); content.querySelectorAll("[data-decision]").forEach(control => control.disabled = false); }
    } finally { pendingDetailActions.delete(action); }
  }));
  const advanceButton = document.getElementById("advance-ticket");
  if (advanceButton) advanceButton.addEventListener("click", () => advanceTicket(item.id));
  const staffMessageForm = document.getElementById("staff-message-form");
  if (staffMessageForm) staffMessageForm.addEventListener("submit", event => {
    event.preventDefault();
    sendStaffMessage(item.id);
  });
  if (draft?.message !== undefined && document.getElementById("staff-message-input")) {
    document.getElementById("staff-message-input").value = draft.message;
  }
  if (draft?.completionDetails !== undefined && document.getElementById("completion-details")) document.getElementById("completion-details").value = draft.completionDetails;
  if (draft?.decisionReason !== undefined && document.getElementById("decision-reason")) document.getElementById("decision-reason").value = draft.decisionReason;
  if (draft?.completionPhoto && document.getElementById("completion-photo")) document.getElementById("completion-photo").replaceWith(draft.completionPhoto);
  if (draft?.focusId) {
    const nextFocus = document.getElementById(draft.focusId);
    if (nextFocus && content.contains(nextFocus)) {
      nextFocus.focus({ preventScroll: true });
      if (draft.selectionStart !== null && typeof nextFocus.setSelectionRange === "function") {
        nextFocus.setSelectionRange(draft.selectionStart, draft.selectionEnd);
      }
    }
  }
  let selectedRating = shownRating;
  document.querySelectorAll(".rating-star").forEach(button => button.addEventListener("click", () => {
    selectedRating = Number(button.dataset.rating);
    document.querySelectorAll(".rating-star").forEach(star => {
      const selected = Number(star.dataset.rating) <= selectedRating;
      star.classList.toggle("selected", selected);
      star.setAttribute("aria-pressed", String(Number(star.dataset.rating) === selectedRating));
    });
  }));
  const feedbackButton = document.getElementById("feedback-submit");
  if (feedbackButton) feedbackButton.addEventListener("click", async () => {
    if (!selectedRating) {
      showToast("Choose a star rating before sending feedback.");
      return;
    }
    const action = `feedback:${item.id}`;
    if (pendingDetailActions.has(action)) return;
    pendingDetailActions.add(action);
    feedbackButton.disabled = true;
    const version = sessionVersion;
    try {
      const result = await apiRequest(`/api/complaints/${encodeURIComponent(item.id)}/feedback`, {
        method: "POST",
        body: { rating: selectedRating, feedback: document.getElementById("feedback-text").value.trim() }
      });
      if (version !== sessionVersion) return;
      Object.assign(item, result.complaint);
      render();
      if (activeDetailId === item.id) renderDetails(item);
      showToast("Thanks for sharing your feedback!");
    } catch (error) {
      if (version === sessionVersion) showToast(error.message || "Feedback could not be saved.");
    } finally {
      pendingDetailActions.delete(action);
      feedbackButton.disabled = false;
    }
  });
}

function openDetails(id) {
  const item = complaints.find(entry => entry.id === id);
  if (!item) return;
  activeDetailId = id;
  renderDetails(item);
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  drawerBackdrop.classList.add("open");
}

function closeDetails() {
  activeDetailId = null;
  drawer.classList.remove("open");
  drawer.setAttribute("aria-hidden", "true");
  drawerBackdrop.classList.remove("open");
}

async function sendStaffMessage(id) {
  if (!isTechnician) return;
  const item = complaints.find(entry => entry.id === id);
  const input = document.getElementById("staff-message-input");
  if (!item || !input) return;
  const text = input.value.trim();
  if (!text) {
    input.focus();
    showToast("Write a message before sending.");
    return;
  }
  const action = `message:${id}`;
  if (pendingDetailActions.has(action)) return;
  pendingDetailActions.add(action);
  const version = sessionVersion;
  const button = document.querySelector('#staff-message-form button[type="submit"]');
  if (button) button.disabled = true;
  try {
    const result = await apiRequest(`/api/complaints/${encodeURIComponent(id)}/messages`, { method: "POST", body: { text } });
    if (version !== sessionVersion) return;
    Object.assign(item, result.complaint);
    input.value = "";
    await refreshAppData(true);
    if (version !== sessionVersion) return;
    render();
    if (activeDetailId === id) renderDetails(complaints.find(entry => entry.id === id) || item, { preserveDraft: true });
    showToast("Message sent to the student.");
  } catch (error) {
    if (version === sessionVersion) showToast(error.message || "Message could not be sent.");
  } finally {
    pendingDetailActions.delete(action);
    if (button) button.disabled = false;
  }
}

async function advanceTicket(id) {
  const item = complaints.find(entry => entry.id === id);
  if (!item) return;
  const nextStatus = item.status === "Assigned" ? "In progress" : "Resolved";
  const completionDetails = document.getElementById("completion-details")?.value.trim() || "";
  if (nextStatus === "Resolved" && !completionDetails) { showToast("Add completion details before resolving."); return; }
  const file = document.getElementById("completion-photo")?.files[0];
  if (file && (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024)) { showToast("Choose a JPEG, PNG or WebP photo up to 5 MB."); return; }
  const assignee = item.assignee && item.assignee !== "Awaiting assignment" ? item.assignee : currentAccount.name;
  const action = `advance:${id}`;
  if (pendingDetailActions.has(action)) return;
  pendingDetailActions.add(action);
  const version = sessionVersion;
  const button = document.getElementById("advance-ticket");
  if (button) button.disabled = true;
  try {
    const completionPhotos = file ? [{ name: file.name, dataUrl: await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(new Error("Photo could not be read.")); reader.readAsDataURL(file); }) }] : [];
    const result = await apiRequest(`/api/complaints/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: { status: nextStatus, completionDetails, completionPhotos }
    });
    if (version !== sessionVersion) return;
    Object.assign(item, result.complaint);
    await refreshAppData(true);
    if (version !== sessionVersion) return;
    render();
    if (activeDetailId === id) renderDetails(complaints.find(entry => entry.id === id) || item, { preserveDraft: true });
    showToast(nextStatus === "Resolved" ? "Ticket resolved. Nice work!" : "Ticket updated successfully.");
  } catch (error) {
    if (version === sessionVersion) showToast(error.message || "Ticket could not be updated.");
  } finally {
    pendingDetailActions.delete(action);
    if (button) button.disabled = false;
  }
}

async function saveQueueUpdate(id, changes) {
  const version = sessionVersion;
  const result = await apiRequest(`/api/complaints/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: { ...changes, visitAt: changes.visitAt || "" }
  });
  if (version !== sessionVersion) return false;
  Object.assign(complaints.find(item => item.id === id) || {}, result.complaint);
  await refreshAppData(true);
  if (version !== sessionVersion) return false;
  render();
  if (activeDetailId === id) {
    const updated = complaints.find(item => item.id === id);
    if (updated) renderDetails(updated, { preserveDraft: true });
  }
  showToast("Report update saved.");
  return true;
}

function toggleRole() {
  signOut();
}

document.getElementById("role-switch").addEventListener("click", toggleRole);
document.getElementById("sidebar-report-button").addEventListener("click", () => document.getElementById("report-button").click());
document.getElementById("track-view-all").addEventListener("click", () => document.querySelector('[data-nav="complaints"]').click());
document.getElementById("recent-view-all").addEventListener("click", () => document.querySelector('[data-nav="updates"]').click());
document.getElementById("quick-contact-button").addEventListener("click", openContact);
document.getElementById("dashboard-recent").addEventListener("click", event => {
  const item = event.target.closest("[data-recent-id]");
  if (item) openDetails(item.dataset.recentId);
});
document.getElementById("report-button").addEventListener("click", () => {
  document.getElementById("modal-overlay").hidden = false;
  setTimeout(() => document.getElementById("issue-title").focus(), 0);
});
document.querySelectorAll("[data-close]").forEach(button => button.addEventListener("click", () => {
  document.getElementById("modal-overlay").hidden = true;
}));
document.getElementById("modal-overlay").addEventListener("click", event => {
  if (event.target.id === "modal-overlay") event.currentTarget.hidden = true;
});
const photoInput = document.getElementById("issue-photo");
photoInput.addEventListener("change", () => {
  const file = photoInput.files && photoInput.files[0];
  const error = document.getElementById("complaint-error");
  const readVersion = ++photoReadVersion;
  photoLoading = false;
  error.hidden = true;
  selectedPhoto = null;
  document.getElementById("photo-preview-image").removeAttribute("src");
  document.getElementById("photo-preview").hidden = true;
  if (!file) return;
  if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 5 * 1024 * 1024) {
    photoInput.value = "";
    error.textContent = file.size > 5 * 1024 * 1024 ? "Choose an image smaller than 5 MB." : "Choose a JPEG, PNG or WebP image.";
    error.hidden = false;
    return;
  }
  const reader = new FileReader();
  photoLoading = true;
  reader.onload = () => {
    if (readVersion !== photoReadVersion) return;
    photoLoading = false;
    if (typeof reader.result !== "string") {
      error.textContent = "The selected photo could not be read.";
      error.hidden = false;
      return;
    }
    selectedPhoto = { name: file.name, dataUrl: reader.result };
    document.getElementById("photo-preview-image").src = reader.result;
    document.getElementById("photo-preview").hidden = false;
  };
  reader.onerror = () => {
    if (readVersion !== photoReadVersion) return;
    photoLoading = false;
    error.textContent = "The selected photo could not be read.";
    error.hidden = false;
  };
  reader.readAsDataURL(file);
});
document.getElementById("remove-photo").addEventListener("click", () => {
  photoReadVersion++;
  photoLoading = false;
  selectedPhoto = null;
  photoInput.value = "";
  document.getElementById("photo-preview-image").removeAttribute("src");
  document.getElementById("photo-preview").hidden = true;
});
document.getElementById("complaint-form").addEventListener("submit", async event => {
  event.preventDefault();
  const complaintForm = event.currentTarget;
  const submitButton = complaintForm.querySelector('button[type="submit"]');
  const error = document.getElementById("complaint-error");
  error.hidden = true;
  if (photoLoading) {
    error.textContent = "Your photo is still loading. Please wait a moment.";
    error.hidden = false;
    return;
  }
  if (photoInput.files.length && !selectedPhoto) {
    error.textContent = "Your photo could not be loaded. Please choose it again or remove it.";
    error.hidden = false;
    return;
  }
  const form = new FormData(complaintForm);
  const category = String(form.get("category"));
  const room = String(form.get("room")).trim();
  const title = String(form.get("title")).trim();
  if (!title || !room) return;
  submitButton.disabled = true;
  submitButton.textContent = "Submitting…";
  const version = sessionVersion;
  try {
    const result = await apiRequest("/api/complaints", {
      method: "POST",
      body: {
        title,
        category,
        room,
        hostel: String(form.get("hostel")),
        priority: String(form.get("priority")),
        description: String(form.get("details")).trim(),
        photos: selectedPhoto ? [selectedPhoto] : []
      }
    });
    if (version !== sessionVersion) return;
    const item = result.complaint;
    complaintForm.reset();
    selectedPhoto = null;
    document.getElementById("photo-preview-image").removeAttribute("src");
    document.getElementById("photo-preview").hidden = true;
    document.getElementById("issue-hostel").value = currentAccount.hostel || "BH-2";
    document.getElementById("issue-room").value = currentAccount.room || "";
    document.getElementById("modal-overlay").hidden = true;
    activeFilter = "all";
    document.getElementById("status-filter").value = "all";
    query = "";
    document.getElementById("search-input").value = "";
    await refreshAppData(true);
    if (version !== sessionVersion) return;
    document.getElementById("confirmation-id").textContent = item.id;
    document.getElementById("confirmation-overlay").hidden = false;
  } catch (requestError) {
    if (version === sessionVersion) {
      error.textContent = requestError.message || "Your report could not be submitted. Please try again.";
      error.hidden = false;
    }
  } finally {
    submitButton.disabled = false;
    submitButton.innerHTML = 'Submit report <span>→</span>';
  }
});
document.getElementById("confirmation-view").addEventListener("click", () => {
  const id = document.getElementById("confirmation-id").textContent;
  document.getElementById("confirmation-overlay").hidden = true;
  if (id) openDetails(id);
});
document.getElementById("confirmation-close").addEventListener("click", () => {
  document.getElementById("confirmation-overlay").hidden = true;
});
document.getElementById("drawer-close").addEventListener("click", closeDetails);
drawerBackdrop.addEventListener("click", closeDetails);
document.getElementById("account-close").addEventListener("click", () => {
  document.getElementById("account-overlay").hidden = true;
});
document.getElementById("account-overlay").addEventListener("click", event => {
  if (event.target.id === "account-overlay") event.currentTarget.hidden = true;
});
document.getElementById("help-close").addEventListener("click", () => {
  document.getElementById("help-overlay").hidden = true;
});
document.getElementById("help-overlay").addEventListener("click", event => {
  if (event.target.id === "help-overlay") event.currentTarget.hidden = true;
});
document.getElementById("contact-close").addEventListener("click", () => {
  document.getElementById("contact-overlay").hidden = true;
});
document.getElementById("contact-overlay").addEventListener("click", event => {
  if (event.target.id === "contact-overlay") event.currentTarget.hidden = true;
});
document.getElementById("search-input").addEventListener("input", event => {
  const nextQuery = event.target.value.trim();
  const shouldShowResults = nextQuery.length > 0 && query.length === 0;
  query = nextQuery;
  render();
  if (shouldShowResults) {
    if (isWarden) {
      document.getElementById("staff-queue-section").scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      document.querySelector('[data-nav="complaints"]').click();
    }
  }
});
document.getElementById("role-overview").addEventListener("click", event => {
  const action = event.target.closest("[data-role-action]")?.dataset.roleAction;
  if (!action) return;
  if (isWarden) {
    const queue = document.getElementById("staff-queue-section");
    queue.querySelectorAll("[data-queue-filter]").forEach(select => { select.value = "all"; select.dispatchEvent(new Event("change", { bubbles: true })); });
    const attention = action === "needs-review" || action === "escalated" ? action : "all";
    const status = action === "progress" ? "In progress" : action === "resolved" ? "Resolved" : "all";
    for (const [key, value] of [["attention", attention], ["status", status]]) {
      const select = queue.querySelector(`[data-queue-filter="${key}"]`);
      if (select) { select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); }
    }
    queue.scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    const statuses = { assigned: "Assigned", progress: "In progress", resolved: "Resolved", closed: "Closed" };
    activeFilter = statuses[action] || "all";
    document.getElementById("status-filter").value = activeFilter;
    render();
    document.getElementById("complaints-section").scrollIntoView({ behavior: "smooth", block: "start" });
  }
});
document.getElementById("status-filter").addEventListener("change", event => { activeFilter = event.target.value; render(); });
document.getElementById("show-all-button").addEventListener("click", () => {
  activeFilter = "all"; query = "";
  document.getElementById("search-input").value = "";
  document.getElementById("status-filter").value = "all";
  render();
});
document.querySelectorAll(".nav-item[data-nav]").forEach(button => button.addEventListener("click", () => {
  document.querySelectorAll(".nav-item[data-nav]").forEach(item => item.classList.remove("active"));
  document.getElementById("help-link").classList.remove("active");
  button.classList.add("active");
  const updatesSection = document.getElementById("updates-section");
  const scrollBehavior = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth";
  if (button.dataset.nav === "complaints") {
    updatesSection.hidden = true;
    document.getElementById("complaints-section").scrollIntoView({ behavior: scrollBehavior, block: "start" });
  } else if (button.dataset.nav === "updates") {
    renderUpdates();
    updatesSection.hidden = false;
    updatesSection.scrollIntoView({ behavior: scrollBehavior, block: "start" });
  } else {
    updatesSection.hidden = true;
    window.scrollTo({ top: 0, behavior: scrollBehavior });
  }
}));
document.getElementById("hero-link").addEventListener("click", () => {
  document.querySelector('[data-nav="complaints"]').click();
});
document.getElementById("hero-focus-button").addEventListener("click", event => {
  const id = event.currentTarget.dataset.id;
  if (id) openDetails(id);
});
document.getElementById("help-button").addEventListener("click", openContact);
document.getElementById("help-link").addEventListener("click", openHelp);
document.getElementById("maintenance-contact-link").addEventListener("click", openContact);
document.getElementById("support-related-report").addEventListener("change", () => {
  const selected = complaints.find(item => item.id === document.getElementById("support-related-report").value);
  if (selected) document.getElementById("support-subject").value = `${selected.id} · ${selected.title}`;
  updateGmailLink();
});
document.getElementById("support-subject").addEventListener("input", updateGmailLink);
document.getElementById("support-message").addEventListener("input", updateGmailLink);
document.getElementById("gmail-compose").addEventListener("click", event => {
  const message = document.getElementById("support-message");
  if (!message.value.trim()) {
    event.preventDefault();
    message.focus();
    message.reportValidity();
    return;
  }
  updateGmailLink();
});
function closeNotificationPanel() {
  document.getElementById("notification-panel").hidden = true;
  document.getElementById("notification-button").setAttribute("aria-expanded", "false");
}

function closeProfileMenu(restoreFocus = false) {
  const menu = document.getElementById("profile-menu");
  const wasOpen = !menu.hidden;
  menu.hidden = true;
  const button = document.getElementById("profile-button");
  button.setAttribute("aria-expanded", "false");
  if (restoreFocus && wasOpen) button.focus();
}

document.getElementById("notification-button").addEventListener("click", () => {
  const panel = document.getElementById("notification-panel");
  const opening = panel.hidden;
  if (opening) closeProfileMenu();
  panel.hidden = !opening;
  document.getElementById("notification-button").setAttribute("aria-expanded", String(opening));
  renderNotifications();
});
document.getElementById("mark-notifications-read").addEventListener("click", () => markNotificationsRead());
document.getElementById("notification-list").addEventListener("click", async event => {
  const notification = event.target.closest("[data-notification-id]");
  if (!notification) return;
  const complaintId = notification.dataset.complaintId;
  if (!await markNotificationsRead(notification.dataset.notificationId)) return;
  closeNotificationPanel();
  openDetails(complaintId);
});
document.addEventListener("click", event => {
  if (!event.target.closest(".notification-wrap")) closeNotificationPanel();
  if (!event.target.closest(".profile-wrap")) closeProfileMenu();
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && currentAccount) refreshAppData(true);
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape") {
    closeProfileMenu(true);
    document.getElementById("modal-overlay").hidden = true;
    document.getElementById("confirmation-overlay").hidden = true;
    document.getElementById("account-overlay").hidden = true;
    document.getElementById("help-overlay").hidden = true;
    document.getElementById("contact-overlay").hidden = true;
    document.getElementById("registration-overlay").hidden = true;
    closeNotificationPanel();
    closeDetails();
  }
});

async function startSession(account) {
  sessionVersion++;
  currentAccount = account;
  isTechnician = account.type === "staff";
  isWarden = account.jobType === "warden";
  document.getElementById("app-shell").dataset.role = isWarden ? "warden" : isTechnician ? "technician" : "student";
  document.getElementById("workspace-label").textContent = isWarden ? "WARDEN DASHBOARD" : isTechnician ? "TECHNICIAN DASHBOARD" : "STUDENT DASHBOARD";
  notifications = [];
  notificationsLoaded = false;
  closeProfileMenu();
  document.getElementById("login-screen").hidden = true;
  document.getElementById("app-shell").hidden = false;
  document.getElementById("profile-name").textContent = account.name;
  document.getElementById("profile-role").textContent = account.role || (isTechnician ? "Maintenance staff" : `Student · ${account.hostel || ""}`);
  document.querySelector(".profile-button .avatar").textContent = account.initials || account.name.split(/\s+/).map(part => part[0]).slice(0, 2).join("").toUpperCase();
  document.querySelector(".profile-button .avatar").classList.toggle("avatar-priya", account.id === "priya");
  document.querySelector(".profile-button .avatar").classList.toggle("avatar-tech", isTechnician);
  document.getElementById("welcome-title").innerHTML = `${greeting()}, ${escapeHtml(account.name.split(" ")[0])} <span class="wave">✳</span>`;
  document.getElementById("welcome-subtitle").textContent = isWarden ? "Review complaints, set priorities, and assign technicians." : isTechnician ? "View your assigned jobs and update residents on repairs." : "A better stay starts with a space that works. We’re on it.";
  document.getElementById("report-button").hidden = isTechnician;
  document.getElementById("sidebar-report-button").hidden = isTechnician;
  document.getElementById("role-switch").hidden = false;
  document.getElementById("switch-label").textContent = "Switch account";
  document.getElementById("role-switch").classList.remove("technician-active");
  document.getElementById("breadcrumb-current").textContent = isWarden ? "Warden dashboard" : isTechnician ? "Technician dashboard" : "Student dashboard";
  document.querySelectorAll(".nav-item[data-nav]").forEach(item => item.classList.toggle("active", item.dataset.nav === "overview"));
  document.getElementById("updates-section").hidden = true;
  closeNotificationPanel();
  activeFilter = "all";
  query = "";
  document.getElementById("search-input").value = "";
  document.getElementById("status-filter").value = "all";
  const hostelSelect = document.getElementById("issue-hostel");
  if (account.hostel && !Array.from(hostelSelect.options).some(option => option.value === account.hostel)) hostelSelect.add(new Option(account.hostel, account.hostel));
  hostelSelect.value = account.hostel || "BH-2";
  document.getElementById("issue-room").value = account.room || "";
  const queue = document.getElementById("staff-queue-section");
  if (window.CampusCareStaffQueue) window.CampusCareStaffQueue.mount(queue, { isStaff: isWarden, onSave: saveQueueUpdate, search: query, technicians });
  await refreshAppData(false);
  clearInterval(pollTimer);
  if (!currentAccount) return;
  pollTimer = setInterval(() => {
    if (document.visibilityState === "visible") refreshAppData(true);
  }, 15000);
}

function clearSessionState() {
  sessionVersion++;
  clearInterval(pollTimer);
  currentAccount = null;
  complaints = [];
  notifications = [];
  technicians = [];
  notificationsLoaded = false;
  isTechnician = false;
  isWarden = false;
  closeDetails();
  closeNotificationPanel();
  closeProfileMenu();
  ["modal-overlay", "confirmation-overlay", "account-overlay", "help-overlay", "contact-overlay", "registration-overlay"].forEach(id => {
    document.getElementById(id).hidden = true;
  });
  document.getElementById("complaint-form").reset();
  selectedPhoto = null;
  photoReadVersion++;
  photoLoading = false;
  document.getElementById("photo-preview-image").removeAttribute("src");
  document.getElementById("photo-preview").hidden = true;
  document.getElementById("complaint-error").hidden = true;
  document.getElementById("app-shell").hidden = true;
  document.getElementById("login-screen").hidden = false;
  document.getElementById("login-form").reset();
  document.getElementById("remember-me").checked = true;
  setLoginType("student");
}

async function signOut() {
  closeProfileMenu();
  try {
    await apiRequest("/api/logout", { method: "POST", body: {} });
  } catch (error) {
    console.error("Could not end the server session:", error);
    showToast("Could not sign out. Check the connection and try again.");
    return;
  }
  clearSessionState();
  document.querySelector('[data-login-role="student"]').focus();
}

function setLoginType(type) {
  loginType = type;
  document.querySelectorAll("[data-login-role]").forEach(button => {
    const selected = button.dataset.loginRole === type;
    button.classList.toggle("selected", selected);
    button.setAttribute("aria-pressed", String(selected));
  });
  const isStaff = type !== "student";
  document.getElementById("login-description").textContent = type === "staff" ? "Sign in as a warden to review complaints and assign work." : type === "technician" ? "Sign in to view your assigned maintenance jobs." : "Sign in to report and track maintenance issues.";
  document.getElementById("login-identity-label").textContent = isStaff ? "Staff ID or email" : "Student ID or email";
  document.getElementById("login-identity").placeholder = isStaff ? "Enter your staff ID or email" : "Enter your student ID or email";
  document.getElementById("demo-heading-label").textContent = type === "staff" ? "CONTINUE WITH A WARDEN DEMO" : type === "technician" ? "CONTINUE WITH A TECHNICIAN DEMO" : "CONTINUE WITH A STUDENT DEMO";
  document.querySelectorAll("[data-demo-account]").forEach(button => {
    button.hidden = button.dataset.accountType !== type;
  });
  document.getElementById("login-identity").value = "";
  document.getElementById("login-password").value = "";
  document.getElementById("login-password").type = "password";
  document.getElementById("password-toggle").textContent = "Show";
  document.getElementById("password-toggle").setAttribute("aria-label", "Show password");
  clearLoginError();
}

const registrationOverlay = document.getElementById("registration-overlay");
const registrationForm = document.getElementById("registration-form");
function updateRegistrationFields() {
  const kind = document.getElementById("register-kind").value;
  const student = kind === "student", technician = kind === "technician";
  registrationForm.querySelector(".student-fields").hidden = !student;
  document.getElementById("register-hostel").required = student;
  document.getElementById("register-room").required = student;
  document.getElementById("register-department-group").hidden = !technician;
  document.getElementById("register-department").required = technician;
  document.getElementById("register-staff-group").hidden = student;
  document.getElementById("register-staff-code").required = !student;
}
document.getElementById("open-registration").addEventListener("click", () => {
  registrationForm.reset(); updateRegistrationFields();
  document.getElementById("registration-error").hidden = true;
  registrationOverlay.hidden = false;
  document.getElementById("register-kind").focus();
});
document.getElementById("registration-close").addEventListener("click", () => { registrationOverlay.hidden = true; document.getElementById("open-registration").focus(); });
registrationOverlay.addEventListener("click", event => { if (event.target === registrationOverlay) registrationOverlay.hidden = true; });
document.getElementById("register-kind").addEventListener("change", updateRegistrationFields);
registrationForm.addEventListener("submit", async event => {
  event.preventDefault();
  const error = document.getElementById("registration-error"), submit = registrationForm.querySelector('button[type="submit"]');
  error.hidden = true;
  const data = new FormData(registrationForm);
  if (data.get("password") !== document.getElementById("register-confirm").value) { error.textContent = "Passwords do not match."; error.hidden = false; return; }
  submit.disabled = true;
  try {
    await apiRequest("/api/register", { method: "POST", body: Object.fromEntries(data.entries()) });
    registrationOverlay.hidden = true;
    setLoginType(data.get("kind") === "warden" ? "staff" : String(data.get("kind")));
    document.getElementById("login-identity").value = String(data.get("identity"));
    document.getElementById("login-description").textContent = "Your account was created. Sign in with your ID and password.";
    document.getElementById("login-password").focus();
    registrationForm.reset();
  } catch (registrationError) {
    error.textContent = registrationError.message || "Your account could not be created.";
    error.hidden = false;
  } finally { submit.disabled = false; }
});

function clearLoginError() {
  const error = document.getElementById("login-error");
  error.hidden = true;
  error.textContent = "";
  ["login-identity", "login-password"].forEach(id => {
    const field = document.getElementById(id);
    field.removeAttribute("aria-invalid");
    field.removeAttribute("aria-errormessage");
  });
}

function openAccountDetails() {
  const account = currentAccount;
  const isStaff = account.type === "staff";
  const details = isStaff
    ? [
      ["Name", account.name], ["Staff ID", account.staffId], ["Work email", account.email],
      ["Role", account.role || "Maintenance staff"], ["Department", account.department], ["Service area", "Residential campus"]
    ]
    : [
      ["Name", account.name], ["Student ID", account.studentId], ["Email", account.email],
      ["Hostel", account.hostel], ["Room", account.room]
    ];
  document.getElementById("account-modal-title").textContent = isStaff ? "Staff account" : "Student account";
  document.getElementById("account-modal-subtitle").textContent = isStaff
    ? "Your staff profile and maintenance settings."
    : "Your profile and hostel details.";
  document.getElementById("account-details-grid").innerHTML = details.map(([label, value]) =>
    `<div class="account-detail"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`
  ).join("");
  const preferences = getPreferences(account, account.type);
  const preferenceItems = isStaff ? [["showResolved", "Include completed visits"]] : [];
  document.getElementById("account-preferences").innerHTML = preferenceItems.map(([key, label]) =>
    `<label class="preference-row"><span>${escapeHtml(label)}</span><input type="checkbox" data-preference="${key}" ${preferences[key] ? "checked" : ""} /></label>`
  ).join("") || '<p>Report updates appear in your in-app notifications.</p>';
  document.querySelectorAll("[data-preference]").forEach(input => input.addEventListener("change", () => {
    savePreference(input.dataset.preference, input.checked);
  }));
  document.getElementById("account-overlay").hidden = false;
}

document.querySelectorAll("[data-login-role]").forEach(button => button.addEventListener("click", () => setLoginType(button.dataset.loginRole)));
document.getElementById("login-form").addEventListener("submit", async event => {
  event.preventDefault();
  clearLoginError();
  const identityField = document.getElementById("login-identity");
  const passwordField = document.getElementById("login-password");
  const identity = identityField.value.trim().toLowerCase();
  const password = passwordField.value;
  const error = document.getElementById("login-error");
  if (!identity || !password) {
    error.textContent = "Enter your ID and password, or select a demo account below.";
    error.hidden = false;
    const invalidField = !identity ? identityField : passwordField;
    invalidField.setAttribute("aria-invalid", "true");
    invalidField.setAttribute("aria-errormessage", "login-error");
    invalidField.focus();
    return;
  }
  const submitButton = event.currentTarget.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  try {
    const result = await apiRequest("/api/login", {
      method: "POST",
      body: { identity, password, role: loginType === "student" ? "student" : "staff", ...(loginType !== "student" ? { jobType: loginType === "staff" ? "warden" : "technician" } : {}), remember: document.getElementById("remember-me").checked }
    });
    await startSession(result.user);
  } catch (loginError) {
    error.textContent = backendHelpMessage(loginError);
    error.hidden = false;
    identityField.setAttribute("aria-invalid", "true");
    identityField.setAttribute("aria-errormessage", "login-error");
    identityField.focus();
  } finally {
    submitButton.disabled = false;
  }
});

["login-identity", "login-password"].forEach(id => {
  document.getElementById(id).addEventListener("input", clearLoginError);
});

document.querySelectorAll("[data-demo-account]").forEach(button => button.addEventListener("click", () => {
  const account = accounts.find(candidate => candidate.id === button.dataset.demoAccount);
  if (!account) return;
  clearLoginError();
  document.getElementById("login-identity").value = account.studentId || account.staffId;
  document.getElementById("login-password").value = demoPassword;
  document.getElementById("login-form").requestSubmit();
}));

document.getElementById("password-toggle").addEventListener("click", event => {
  const password = document.getElementById("login-password");
  const reveal = password.type === "password";
  password.type = reveal ? "text" : "password";
  event.currentTarget.textContent = reveal ? "Hide" : "Show";
  event.currentTarget.setAttribute("aria-label", reveal ? "Hide password" : "Show password");
});
document.getElementById("forgot-password").addEventListener("click", () => {
  showToast("This demo uses sample accounts only. Contact your hostel office for real account access.");
});
document.getElementById("logout-button").addEventListener("click", signOut);
document.getElementById("profile-button").addEventListener("click", () => {
  const menu = document.getElementById("profile-menu");
  const opening = menu.hidden;
  if (opening) closeNotificationPanel();
  menu.hidden = !opening;
  document.getElementById("profile-button").setAttribute("aria-expanded", String(opening));
});
document.getElementById("account-details-button").addEventListener("click", () => {
  closeProfileMenu();
  openAccountDetails();
});
document.querySelector(".profile-wrap").addEventListener("focusout", event => {
  if (!event.currentTarget.contains(event.relatedTarget)) closeProfileMenu();
});

async function restoreSession() {
  try {
    const result = await apiRequest("/api/session");
    await startSession(result.user);
  } catch (error) {
    document.getElementById("app-shell").hidden = true;
    document.getElementById("login-screen").hidden = false;
    if (!/sign in to continue/i.test(error.message)) {
      const loginError = document.getElementById("login-error");
      loginError.textContent = backendHelpMessage(error);
      loginError.hidden = false;
    }
  }
}

restoreSession();
