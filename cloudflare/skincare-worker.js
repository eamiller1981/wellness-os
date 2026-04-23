const DEFAULT_NOTION_ORIGIN = "https://eamiller1981.github.io";
const USER_TIME_ZONE = "America/New_York";

const MODE_VALUES = new Set(["cycle", "travel", "minimal"]);
const ALLOWED_ORIGINS = new Set([
  "https://eamiller1981.github.io",
  "https://wellness-os.vercel.app",
  "http://127.0.0.1:4173",
  "http://localhost:4173"
]);

const WELLNESS_PREVIEW_ORIGIN =
  /^https:\/\/wellness-[a-z0-9-]+-eamiller1981-3240s-projects\.vercel\.app$/;

class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function isAllowedOrigin(origin) {
  return Boolean(origin) && (ALLOWED_ORIGINS.has(origin) || WELLNESS_PREVIEW_ORIGIN.test(origin));
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin"
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      ...corsHeaders(origin)
    }
  });
}

function normalizeMode(value) {
  const normalized = String(value || "cycle").trim().toLowerCase();
  return MODE_VALUES.has(normalized) ? normalized : "cycle";
}

function dateStringInZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  });
  return formatter.format(date);
}

function addDays(dateString, deltaDays) {
  const [year, month, day] = dateString.split("-").map(Number);
  const utcDate = new Date(Date.UTC(year, month - 1, day + deltaDays));
  return dateStringInZone(utcDate, "UTC");
}

function compareDateStrings(left, right) {
  return left.localeCompare(right);
}

function parseNightOrder(value) {
  const match = String(value || "").match(/(\d+)/);
  return match ? Number(match[1]) : null;
}

function firstRichTextValue(prop) {
  if (!prop) return "";

  if (prop.type === "title" || prop.type === "rich_text") {
    return (prop[prop.type] || []).map((entry) => entry.plain_text || "").join("").trim();
  }

  if (prop.type === "formula") {
    if (prop.formula.type === "string") return prop.formula.string || "";
    if (prop.formula.type === "number") return String(prop.formula.number ?? "");
    if (prop.formula.type === "date") return prop.formula.date?.start || "";
  }

  if (prop.type === "select") return prop.select?.name || "";
  if (prop.type === "multi_select") return (prop.multi_select || []).map((entry) => entry.name).filter(Boolean).join(", ");
  if (prop.type === "number") return prop.number == null ? "" : String(prop.number);
  if (prop.type === "date") return prop.date?.start || "";
  if (prop.type === "checkbox") return prop.checkbox ? "true" : "false";

  return "";
}

function multiSelectValues(prop) {
  if (!prop || prop.type !== "multi_select") return [];
  return (prop.multi_select || []).map((entry) => entry.name).filter(Boolean);
}

function relationIds(prop) {
  if (!prop || prop.type !== "relation") return [];
  return (prop.relation || []).map((entry) => entry.id).filter(Boolean);
}

function numberValue(prop) {
  if (!prop) return null;
  if (prop.type === "number") return prop.number;
  if (prop.type === "formula" && prop.formula.type === "number") return prop.formula.number;
  return null;
}

function dateValue(prop) {
  if (!prop) return "";
  if (prop.type === "date") return prop.date?.start || "";
  if (prop.type === "formula" && prop.formula.type === "date") return prop.formula.date?.start || "";
  return "";
}

function checkboxValue(prop) {
  return Boolean(prop && prop.type === "checkbox" && prop.checkbox);
}

function firstAvailableValue(props, names) {
  for (const name of names) {
    const value = firstRichTextValue(props?.[name]);
    if (value) return value;
  }

  return "";
}

function parseJson(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function integrationShareMessage(details) {
  const message = details?.message || "Notion returned an error.";
  if (details?.code === "object_not_found" && /shared with your integration/i.test(message)) {
    return {
      message: "The Skincare databases are not shared with the Notion integration yet. Share them with the integration \"budget_run\" and the live worker will start resolving data.",
      upstream: details
    };
  }

  return {
    message,
    upstream: details
  };
}

async function notionFetch(env, path, init) {
  const upstreamRequest = new Request(`https://notion-proxy/notion${path}`, {
    method: init?.method || "GET",
    headers: {
      "Content-Type": "application/json",
      Origin: env.UPSTREAM_ORIGIN || DEFAULT_NOTION_ORIGIN
    },
    body: init?.body ? JSON.stringify(init.body) : undefined
  });

  const response = env.NOTION_PROXY?.fetch
    ? await env.NOTION_PROXY.fetch(upstreamRequest)
    : await fetch(`${env.UPSTREAM_NOTION_URL}${path}`, {
        method: init?.method || "GET",
        headers: {
          "Content-Type": "application/json",
          Origin: env.UPSTREAM_ORIGIN || DEFAULT_NOTION_ORIGIN
        },
        body: init?.body ? JSON.stringify(init.body) : undefined
      });

  const data = parseJson(await response.text());
  if (!response.ok || data?.object === "error") {
    throw new HttpError(response.status || data?.status || 500, "Upstream Notion request failed", integrationShareMessage(data));
  }

  return data;
}

async function notionQueryDatabase(env, databaseId, body) {
  return notionFetch(env, `/databases/${databaseId}/query`, { method: "POST", body });
}

async function notionGetPage(env, pageId) {
  return notionFetch(env, `/pages/${pageId}`);
}

async function getMode(env) {
  const raw = await env.SKINCARE_STATE.get("mode", "json");
  return normalizeMode(raw?.mode || "cycle");
}

async function setMode(env, mode) {
  const normalized = normalizeMode(mode);
  await env.SKINCARE_STATE.put(
    "mode",
    JSON.stringify({
      mode: normalized,
      updatedAt: new Date().toISOString()
    })
  );
  return normalized;
}

function buildCycleRecord(page, today) {
  const props = page.properties || {};
  const startDate = dateValue(props["Start Date"]);
  const endDate = dateValue(props["End Date"]);

  if (!startDate || !endDate) {
    return null;
  }

  const start = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  const totalNights = Math.floor((end - start) / 86400000) + 1;
  const nightNumber = Math.floor((new Date(`${today}T00:00:00Z`) - start) / 86400000) + 1;
  const progressPercent = totalNights > 0 ? Math.round((nightNumber / totalNights) * 100) : 0;

  return {
    id: page.id,
    name: firstRichTextValue(props.Name),
    startDate,
    endDate,
    totalNights,
    nightNumber,
    progressPercent
  };
}

async function queryActiveCycles(env, databaseId, today) {
  const data = await notionQueryDatabase(env, databaseId, { page_size: 50 });
  return (data.results || [])
    .map((page) => buildCycleRecord(page, today))
    .filter(Boolean)
    .filter((cycle) => compareDateStrings(cycle.startDate, today) <= 0 && compareDateStrings(cycle.endDate, today) >= 0);
}

async function resolveActiveCycle(env, today) {
  const normalizedCycles = await queryActiveCycles(env, env.CYCLES_DB_ID, today);
  if (normalizedCycles.length === 1) {
    return { ...normalizedCycles[0], source: "normalized" };
  }

  if (normalizedCycles.length > 1) {
    throw new HttpError(409, "Cycle configuration error", {
      message: `Expected exactly one active cycle in the normalized Skincare backend for ${today}, found ${normalizedCycles.length}.`,
      cycles: normalizedCycles
    });
  }

  if (!env.LEGACY_CYCLES_DB_ID) {
    throw new HttpError(404, "No active cycle found", {
      message: `No active cycle exists for ${today}.`
    });
  }

  const legacyCycles = await queryActiveCycles(env, env.LEGACY_CYCLES_DB_ID, today);
  if (legacyCycles.length !== 1) {
    throw new HttpError(409, "Cycle configuration error", {
      message: `Expected exactly one active legacy cycle for ${today}, found ${legacyCycles.length}.`,
      cycles: legacyCycles
    });
  }

  return { ...legacyCycles[0], source: "legacy" };
}

function buildStepGroupRecord(page) {
  const props = page.properties || {};
  return {
    id: page.id,
    name: firstAvailableValue(props, ["Name", "Step Group"]),
    description: firstRichTextValue(props.Description),
    groupType: firstRichTextValue(props["Group Type"]),
    active: checkboxValue(props.Active)
  };
}

async function resolveSingleStepGroupByType(env, groupType, mustBeActive = false) {
  const data = await notionQueryDatabase(env, env.STEP_GROUPS_DB_ID, {
    page_size: 25,
    filter: {
      property: "Group Type",
      select: {
        equals: groupType
      }
    }
  });

  let groups = (data.results || []).map(buildStepGroupRecord);
  if (mustBeActive) {
    groups = groups.filter((group) => group.active);
  }

  if (groups.length !== 1) {
    throw new HttpError(409, "Step Group configuration error", {
      message: `Expected exactly one ${mustBeActive ? "active " : ""}${groupType} step group, found ${groups.length}.`,
      groups
    });
  }

  return groups[0];
}

async function resolveStepGroupPage(env, pageId) {
  const page = await notionGetPage(env, pageId);
  return buildStepGroupRecord(page);
}

async function resolveStepGroupPageCached(env, pageId, cache) {
  if (cache.has(pageId)) {
    return cache.get(pageId);
  }

  const group = await resolveStepGroupPage(env, pageId);
  cache.set(pageId, group);
  return group;
}

function normalizeDevicePlacement(value) {
  return String(value || "").trim().toLowerCase() === "after steps" ? "after" : "before";
}

function isDeviceStep(step) {
  return (
    String(step?.type || "").trim().toLowerCase() === "tool" ||
    String(step?.category || "").trim().toLowerCase() === "device"
  );
}

async function resolveProductRecord(env, pageId, cache) {
  if (!pageId) {
    return {
      name: "Unnamed product",
      category: "",
      devicePlacement: "before"
    };
  }

  if (cache.has(pageId)) return cache.get(pageId);

  const page = await notionGetPage(env, pageId);
  const record = {
    name:
      firstRichTextValue(page.properties?.Name) ||
      firstRichTextValue(page.properties?.Product) ||
      "Unnamed product",
    category: firstRichTextValue(page.properties?.Category) || "",
    devicePlacement: normalizeDevicePlacement(firstRichTextValue(page.properties?.["Device Placement"]))
  };

  cache.set(pageId, record);
  return record;
}

async function resolveStepsForGroup(env, stepGroupId, productCache) {
  const data = await notionQueryDatabase(env, env.STEPS_DB_ID, {
    page_size: 50,
    filter: {
      property: "Step Group",
      relation: {
        contains: stepGroupId
      }
    },
    sorts: [
      {
        property: "Step Order",
        direction: "ascending"
      }
    ]
  });

  const steps = [];
  for (const page of data.results || []) {
    const props = page.properties || {};
    const productId = relationIds(props.Product)[0] || null;
    const product = await resolveProductRecord(env, productId, productCache);
    steps.push({
      id: page.id,
      product: product.name,
      category: product.category,
      devicePlacement: product.devicePlacement,
      type: firstRichTextValue(props["Step Type"]) || "Other",
      notes: firstRichTextValue(props["Application Notes"]),
      waitMin: numberValue(props["Wait Time (min)"]) || 0
    });
  }

  return steps;
}

async function resolveStepsForGroupCached(env, stepGroupId, productCache, stepCache) {
  if (stepCache.has(stepGroupId)) {
    return stepCache.get(stepGroupId);
  }

  const steps = await resolveStepsForGroup(env, stepGroupId, productCache);
  stepCache.set(stepGroupId, steps);
  return steps;
}

function uniqueOrdered(values) {
  const seen = new Set();
  const ordered = [];

  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    ordered.push(value);
  }

  return ordered;
}

function toolDeviceNamesFromSteps(steps) {
  return uniqueOrdered(
    (steps || [])
      .filter((step) => isDeviceStep(step))
      .map((step) => step.product)
  );
}

async function resolveDeviceNamesForGroups(env, groups, productCache) {
  const devices = [];

  for (const group of groups.filter(Boolean)) {
    const steps = await resolveStepsForGroup(env, group.id, productCache);
    devices.push(...toolDeviceNamesFromSteps(steps));
  }

  return uniqueOrdered(devices);
}

async function buildSection(env, groupId, label, tone, productCache) {
  const group = await resolveStepGroupPage(env, groupId);
  const steps = await resolveStepsForGroup(env, groupId, productCache);
  return {
    key: label.toLowerCase(),
    label,
    tone,
    group,
    steps
  };
}

function collectStepsByType(rawSections, matcher) {
  return rawSections.flatMap((section) => (section.steps || []).filter((step) => matcher(step, section)));
}

function buildDisplaySections(rawSections) {
  const baseSteps = collectStepsByType(rawSections, (step, section) => {
    return section.key === "base" && !isDeviceStep(step);
  });

  const beforeDeviceSteps = collectStepsByType(rawSections, (step) => {
    return isDeviceStep(step) && normalizeDevicePlacement(step.devicePlacement) !== "after";
  });

  const afterDeviceSteps = collectStepsByType(rawSections, (step) => {
    return isDeviceStep(step) && normalizeDevicePlacement(step.devicePlacement) === "after";
  });

  const routineSteps = collectStepsByType(rawSections, (step, section) => {
    return section.key !== "base" && !isDeviceStep(step);
  });

  const sections = [];

  if (baseSteps.length) {
    sections.push({
      key: "base",
      label: "Base",
      tone: "base",
      steps: baseSteps
    });
  }

  if (beforeDeviceSteps.length) {
    sections.push({
      key: "device",
      label: "Device",
      tone: "device",
      steps: beforeDeviceSteps
    });
  }

  if (routineSteps.length) {
    sections.push({
      key: "steps",
      label: "Steps",
      tone: "steps",
      steps: routineSteps
    });
  }

  if (afterDeviceSteps.length) {
    sections.push({
      key: "device",
      label: "Device",
      tone: "device",
      steps: afterDeviceSteps
    });
  }

  return sections;
}

function orderRoutineStepsForDisplay(steps) {
  const beforeDeviceSteps = [];
  const routineSteps = [];
  const afterDeviceSteps = [];

  for (const step of steps) {
    if (!isDeviceStep(step)) {
      routineSteps.push(step);
      continue;
    }

    if (normalizeDevicePlacement(step.devicePlacement) === "after") {
      afterDeviceSteps.push(step);
    } else {
      beforeDeviceSteps.push(step);
    }
  }

  return [...beforeDeviceSteps, ...routineSteps, ...afterDeviceSteps];
}

function buildAssignmentRecord(page) {
  const props = page.properties || {};
  const nightLabel = firstRichTextValue(props.Night) || firstRichTextValue(props.Name) || "";

  return {
    id: page.id,
    cycleId: relationIds(props.Cycle)[0] || null,
    date: dateValue(props.Date),
    nightLabel,
    nightOrder: parseNightOrder(nightLabel),
    phase: firstRichTextValue(props.Phase) || "",
    intensityTier: numberValue(props["Intensity Tier"]),
    blockId: relationIds(props.Block)[0] || null,
    treatmentId: relationIds(props.Treatment)[0] || null,
    stepGroupIds: relationIds(props["Step Groups"]),
    blockTitle: firstRichTextValue(props["Block Title"]),
    overridden: checkboxValue(props.Overridden)
  };
}

function compareAssignmentRecords(left, right) {
  const leftNight = left.nightOrder;
  const rightNight = right.nightOrder;

  if (leftNight != null && rightNight != null && leftNight !== rightNight) {
    return leftNight - rightNight;
  }

  if (left.date && right.date && left.date !== right.date) {
    return compareDateStrings(left.date, right.date);
  }

  if (leftNight != null && rightNight == null) return -1;
  if (leftNight == null && rightNight != null) return 1;
  if (left.date && !right.date) return -1;
  if (!left.date && right.date) return 1;

  return String(left.nightLabel || left.id).localeCompare(String(right.nightLabel || right.id));
}

async function resolveAssignmentsForCycle(env, cycleId) {
  const data = await notionQueryDatabase(env, env.NIGHTLY_ASSIGNMENTS_DB_ID, {
    page_size: 200,
    filter: {
      property: "Cycle",
      relation: {
        contains: cycleId
      }
    }
  });

  return (data.results || []).map(buildAssignmentRecord).sort(compareAssignmentRecords);
}

async function resolveAllAssignments(env) {
  const data = await notionQueryDatabase(env, env.NIGHTLY_ASSIGNMENTS_DB_ID, {
    page_size: 200
  });

  return (data.results || []).map(buildAssignmentRecord).sort(compareAssignmentRecords);
}

async function resolveAssignmentsForDate(env, dateString, cycleId) {
  const data = await notionQueryDatabase(env, env.NIGHTLY_ASSIGNMENTS_DB_ID, {
    page_size: 10,
    filter: {
      property: "Date",
      date: {
        equals: dateString
      }
    }
  });

  const assignments = (data.results || []).filter((page) => {
    const cycleIds = relationIds(page.properties?.Cycle);
    return !cycleId || cycleIds.includes(cycleId);
  });

  if (!assignments.length) {
    return null;
  }

  if (assignments.length > 1) {
    throw new HttpError(409, "Nightly assignment configuration error", {
      message: `Expected one nightly assignment for ${dateString}, found ${assignments.length}.`
    });
  }

  return buildAssignmentRecord(assignments[0]);
}

async function resolveAssignmentById(env, assignmentId) {
  const page = await notionGetPage(env, assignmentId);
  return buildAssignmentRecord(page);
}

async function resolveAssignmentGroups(env, assignment) {
  let blockGroup = assignment.blockId ? await resolveStepGroupPage(env, assignment.blockId) : null;
  let treatmentGroup = assignment.treatmentId ? await resolveStepGroupPage(env, assignment.treatmentId) : null;

  if ((blockGroup || treatmentGroup) || !assignment.stepGroupIds?.length) {
    return { blockGroup, treatmentGroup };
  }

  const relatedGroups = await Promise.all(
    assignment.stepGroupIds.map((pageId) => resolveStepGroupPage(env, pageId))
  );

  const blockCandidates = relatedGroups.filter((group) => group.groupType === "Block");
  const treatmentCandidates = relatedGroups.filter((group) => group.groupType === "At-Home Treatment");

  if (!blockGroup) {
    if (blockCandidates.length > 1) {
      throw new HttpError(409, "Nightly assignment configuration error", {
        message: `Expected at most one Block step group on nightly assignment ${assignment.id}, found ${blockCandidates.length}.`,
        groups: blockCandidates
      });
    }

    blockGroup = blockCandidates[0] || null;
  }

  if (!treatmentGroup) {
    if (treatmentCandidates.length > 1) {
      throw new HttpError(409, "Nightly assignment configuration error", {
        message: `Expected at most one At-Home Treatment step group on nightly assignment ${assignment.id}, found ${treatmentCandidates.length}.`,
        groups: treatmentCandidates
      });
    }

    treatmentGroup = treatmentCandidates[0] || null;
  }

  return { blockGroup, treatmentGroup };
}

async function resolvePreviewFromAssignment(env, assignment) {
  if (!assignment) {
    return {
      assignmentId: null,
      date: "",
      nightLabel: "",
      blockName: "",
      deviceName: "",
      deviceNames: []
    };
  }

  const { blockGroup, treatmentGroup } = await resolveAssignmentGroups(env, assignment);
  const productCache = new Map();
  const deviceNames = await resolveDeviceNamesForGroups(env, [blockGroup, treatmentGroup], productCache);
  return {
    assignmentId: assignment.id,
    date: assignment.date || "",
    nightLabel: assignment.nightLabel || "",
    blockName: blockGroup?.name || assignment.blockTitle || "",
    deviceName: deviceNames.join(" / "),
    deviceNames
  };
}

function buildLegacyRoutineDayRecord(page) {
  const props = page.properties || {};
  return {
    id: page.id,
    day: numberValue(props.Day) || 0,
    week: numberValue(props.Week) || null,
    blockName: firstRichTextValue(props["Block Name"]) || "Routine",
    baseName: firstRichTextValue(props.Base),
    devices: multiSelectValues(props.Device).filter((value) => value && value !== "None"),
    phase: firstRichTextValue(props.Phase),
    skincareText: firstRichTextValue(props.Skincare),
    treatmentNotes: firstRichTextValue(props["Treatment Notes"])
  };
}

async function resolveLegacyRoutineDay(env, dayNumber) {
  const data = await notionQueryDatabase(env, env.LEGACY_ROUTINE_DB_ID, {
    page_size: 3,
    filter: {
      property: "Day",
      number: {
        equals: dayNumber
      }
    }
  });

  const records = (data.results || []).map(buildLegacyRoutineDayRecord);
  if (!records.length) {
    return null;
  }

  if (records.length > 1) {
    throw new HttpError(409, "Routine configuration error", {
      message: `Expected one routine row for Day ${dayNumber}, found ${records.length}.`,
      records
    });
  }

  return records[0];
}

function splitRoutineTextIntoSteps(text) {
  const cleaned = String(text || "")
    .replace(/\r/g, "\n")
    .split(/\n+/)
    .map((line) => line.replace(/^[\-\u2022]\s*/, "").trim())
    .filter(Boolean);

  if (cleaned.length) {
    return cleaned;
  }

  const singleLine = String(text || "").trim();
  return singleLine ? [singleLine] : [];
}

function buildLegacyRoutineSections(dayRecord) {
  const sections = [];

  if (dayRecord.baseName) {
    sections.push({
      key: "base",
      label: "Base",
      tone: "base",
      steps: [
        {
          id: `${dayRecord.id}-base-1`,
          product: dayRecord.baseName,
          type: "Cleanse",
          notes: "",
          waitMin: 0
        }
      ]
    });
  }

  const beforeDevices = dayRecord.devices.filter((deviceName) => !/medicube booster pro/i.test(deviceName));
  const afterDevices = dayRecord.devices.filter((deviceName) => /medicube booster pro/i.test(deviceName));

  if (beforeDevices.length) {
    sections.push({
      key: "device",
      label: "Device",
      tone: "device",
      steps: beforeDevices.map((deviceName, index) => ({
        id: `${dayRecord.id}-device-before-${index + 1}`,
        product: deviceName,
        type: "Tool",
        category: "Device",
        devicePlacement: "before",
        notes: dayRecord.treatmentNotes,
        waitMin: 0
      }))
    });
  }

  const blockStepNames = splitRoutineTextIntoSteps(dayRecord.skincareText);
  sections.push({
    key: "steps",
    label: "Steps",
    tone: "steps",
    steps: (blockStepNames.length ? blockStepNames : [dayRecord.blockName]).map((stepName, index) => ({
      id: `${dayRecord.id}-block-${index + 1}`,
      product: stepName,
      type: "Treat",
      category: "",
      devicePlacement: "before",
      notes: "",
      waitMin: 0
    }))
  });

  if (afterDevices.length) {
    sections.push({
      key: "device",
      label: "Device",
      tone: "device",
      steps: afterDevices.map((deviceName, index) => ({
        id: `${dayRecord.id}-device-after-${index + 1}`,
        product: deviceName,
        type: "Tool",
        category: "Device",
        devicePlacement: "after",
        notes: dayRecord.treatmentNotes,
        waitMin: 0
      }))
    });
  }

  return sections;
}

function routineNote(dayRecord) {
  return dayRecord.treatmentNotes || "";
}

async function resolveGroupLikeName(env, pageId) {
  if (!pageId) return "Routine";
  const page = await notionGetPage(env, pageId);
  return (
    firstAvailableValue(page.properties, ["Name", "Step Group"]) ||
    firstRichTextValue(page.properties?.["Block Name"]) ||
    firstRichTextValue(page.properties?.Log) ||
    "Routine"
  );
}

function editableWindowStatus(submittedAt) {
  if (!submittedAt) return { canEdit: false, editableUntil: null };
  const submitted = new Date(submittedAt);
  const editableUntil = new Date(submitted.getTime() + 24 * 60 * 60 * 1000);
  return {
    canEdit: Date.now() < editableUntil.getTime(),
    editableUntil: editableUntil.toISOString()
  };
}

async function resolveYesterdayPayload(env) {
  const yesterday = addDays(dateStringInZone(new Date(), USER_TIME_ZONE), -1);
  const databaseIds = [env.DAILY_LOGS_DB_ID];

  if (env.LEGACY_DAILY_LOGS_DB_ID && env.LEGACY_DAILY_LOGS_DB_ID !== env.DAILY_LOGS_DB_ID) {
    databaseIds.push(env.LEGACY_DAILY_LOGS_DB_ID);
  }

  for (const databaseId of databaseIds) {
    const data = await notionQueryDatabase(env, databaseId, {
      page_size: 5,
      filter: {
        property: "Date",
        date: {
          equals: yesterday
        }
      }
    });

    if (!(data.results || []).length) {
      continue;
    }

    const page = data.results[0];
    const props = page.properties || {};
    const blockId = relationIds(props["Block Used"])[0] || null;
    const blockName = blockId ? await resolveGroupLikeName(env, blockId) : "Routine";
    const completionNumber = numberValue(props["Completion %"]);
    const completionText =
      completionNumber != null
        ? `${Math.round(completionNumber)}% completed`
        : firstRichTextValue(props["Completion %"]) || "Completed";
    const submittedAt = dateValue(props["Submitted At"]);
    const editWindow = editableWindowStatus(submittedAt);

    return {
      date: yesterday,
      log: {
        id: page.id,
        blockName,
        completion: completionText,
        exceptionsCount: numberValue(props["Exceptions Count"]) || numberValue(props["Exceptions (count)"]) || 0,
        submittedAt,
        ...editWindow
      }
    };
  }

  return {
    date: yesterday,
    log: null
  };
}

async function resolveNextFromNormalized(env, dateString, cycleId) {
  const assignment = await resolveAssignmentsForDate(env, dateString, cycleId);
  const preview = await resolvePreviewFromAssignment(env, assignment);
  return {
    ...preview,
    date: preview.date || dateString
  };
}

async function resolveRoutineRows(env, today) {
  const assignments = await resolveAllAssignments(env);
  const productCache = new Map();
  const stepGroupCache = new Map();
  const stepCache = new Map();
  const rows = [];

  for (const assignment of assignments) {
    const stepGroupIds = assignment.stepGroupIds || [];
    const stepGroups = [];
    const flattenedSteps = [];

    for (const stepGroupId of stepGroupIds) {
      const group = await resolveStepGroupPageCached(env, stepGroupId, stepGroupCache);
      stepGroups.push(group);
      const groupSteps = await resolveStepsForGroupCached(env, stepGroupId, productCache, stepCache);
      flattenedSteps.push(...groupSteps);
    }

    const orderedSteps = orderRoutineStepsForDisplay(flattenedSteps);

    rows.push({
      id: assignment.id,
      night: assignment.nightLabel || "",
      nightOrder: assignment.nightOrder,
      date: assignment.date || "",
      phase: assignment.phase || "",
      stepGroups: stepGroups.map((group) => group.name).filter(Boolean),
      steps: orderedSteps.map((step) => step.product).filter(Boolean),
      intensityTier: assignment.intensityTier,
      isToday: assignment.date === today
    });
  }

  return rows;
}

async function resolveRoutinePlanPayload(env) {
  const today = dateStringInZone(new Date(), USER_TIME_ZONE);
  const cycle = await resolveActiveCycle(env, today);

  if (cycle.source !== "normalized") {
    throw new HttpError(409, "Routine plan unavailable", {
      message: "The 90 day routine view is available once the active cycle is using the normalized Nightly Assignments database."
    });
  }

  return {
    ok: true,
    today,
    cycle,
    columns: ["Night", "Date", "Phase", "Step Groups", "Steps", "Intensity Tier"],
    rows: await resolveRoutineRows(env, today)
  };
}

async function resolveNextFromLegacy(env, dayNumber, dateString) {
  const nextRecord = await resolveLegacyRoutineDay(env, dayNumber);
  return {
    assignmentId: nextRecord?.id || null,
    date: dateString,
    nightLabel: nextRecord?.day ? `Day ${String(nextRecord.day).padStart(2, "0")}` : "",
    blockName: nextRecord?.blockName || "",
    deviceName: nextRecord?.devices?.join(" / ") || "",
    deviceNames: nextRecord?.devices || []
  };
}

function buildAssignmentMetadata(assignment, extras = {}) {
  return {
    id: assignment?.id || null,
    date: assignment?.date || "",
    nightLabel: assignment?.nightLabel || "",
    nightOrder: assignment?.nightOrder ?? null,
    phase: assignment?.phase || "",
    intensityTier: assignment?.intensityTier ?? null,
    overridden: extras.overridden ?? assignment?.overridden ?? false,
    blockId: extras.blockId ?? assignment?.blockId ?? null,
    treatmentId: extras.treatmentId ?? assignment?.treatmentId ?? null,
    dayNumber: extras.dayNumber ?? null
  };
}

async function resolveOverridePayloadForAssignment(env, today, cycle, mode, assignment, nextAssignment) {
  const overrideGroupType = mode === "travel" ? "PM Travel" : "PM Minimal";
  const overrideGroup = await resolveSingleStepGroupByType(env, overrideGroupType, false);
  const productCache = new Map();
  const rawOverrideSections = [await buildSection(env, overrideGroup.id, "Steps", "steps", productCache)];
  const overrideSections = buildDisplaySections(rawOverrideSections);
  const overrideDevices = uniqueOrdered(
    overrideSections.flatMap((section) => toolDeviceNamesFromSteps(section.steps))
  );
  const fallbackNextDate = addDays(assignment?.date || today, 1);

  return {
    today,
    mode,
    cycle,
    assignment: buildAssignmentMetadata(assignment, { overridden: true }),
    routine: {
      blockName: overrideGroup.name || (mode === "travel" ? "Travel Mode" : "Minimal Mode"),
      treatmentName: null,
      devices: overrideDevices,
      note: overrideGroup.description,
      sections: overrideSections
    },
    next: {
      assignmentId: nextAssignment?.id || null,
      date: nextAssignment?.date || fallbackNextDate,
      nightLabel: nextAssignment?.nightLabel || "",
      blockName: overrideGroup.name || (mode === "travel" ? "Travel Mode" : "Minimal Mode"),
      deviceName: overrideDevices.join(" / "),
      deviceNames: overrideDevices
    }
  };
}

async function resolveOverridePayload(env, today, cycle, mode) {
  let assignment = null;
  let nextAssignment = null;

  if (cycle.source === "normalized") {
    const assignments = await resolveAssignmentsForCycle(env, cycle.id);
    assignment = assignments.find((item) => item.date === today) || null;
    if (assignment) {
      const index = assignments.findIndex((item) => item.id === assignment.id);
      nextAssignment = index >= 0 ? assignments[index + 1] || null : null;
    }
  }

  return resolveOverridePayloadForAssignment(env, today, cycle, mode, assignment, nextAssignment);
}

async function resolveNormalizedPayloadForAssignment(env, today, cycle, mode, assignment, nextAssignment) {
  if (!assignment) {
    throw new HttpError(404, "No nightly assignment found", {
      message: `No nightly assignment exists for ${today} in the normalized Skincare backend.`
    });
  }

  const pmBase = await resolveSingleStepGroupByType(env, "PM Base", true);
  const { blockGroup, treatmentGroup } = await resolveAssignmentGroups(env, assignment);

  if (!blockGroup) {
    throw new HttpError(409, "Nightly assignment configuration error", {
      message: `The nightly assignment${assignment.date ? ` for ${assignment.date}` : ""} does not resolve to a Block step group.`
    });
  }

  const productCache = new Map();
  const rawSections = [
    await buildSection(env, pmBase.id, "Base", "base", productCache),
    await buildSection(env, blockGroup.id, "Steps", "steps", productCache)
  ];

  if (treatmentGroup) {
    rawSections.push(await buildSection(env, treatmentGroup.id, "Steps", "steps", productCache));
  }

  const sections = buildDisplaySections(rawSections);

  const deviceNames = uniqueOrdered(
    sections.flatMap((section) => toolDeviceNamesFromSteps(section.steps))
  );

  return {
    today,
    mode,
    cycle,
    assignment: buildAssignmentMetadata(assignment, {
      blockId: blockGroup.id,
      treatmentId: treatmentGroup?.id || null
    }),
    routine: {
      blockName: blockGroup.name,
      treatmentName: treatmentGroup?.name || null,
      devices: deviceNames,
      note: blockGroup.description,
      sections
    },
    next: nextAssignment
      ? await resolvePreviewFromAssignment(env, nextAssignment)
      : await resolveNextFromNormalized(env, addDays(assignment.date || today, 1), cycle.id)
  };
}

async function resolveNormalizedTonightPayload(env, today, cycle, mode) {
  const assignments = await resolveAssignmentsForCycle(env, cycle.id);
  const todayAssignment = assignments.find((assignment) => assignment.date === today) || null;
  const currentIndex = todayAssignment ? assignments.findIndex((assignment) => assignment.id === todayAssignment.id) : -1;
  const nextAssignment = currentIndex >= 0 ? assignments[currentIndex + 1] || null : null;
  return resolveNormalizedPayloadForAssignment(env, today, cycle, mode, todayAssignment, nextAssignment);
}

async function resolveLegacyTonightPayload(env, today, cycle, mode) {
  const tonightRecord = await resolveLegacyRoutineDay(env, cycle.nightNumber);
  if (!tonightRecord) {
    throw new HttpError(404, "No routine found for tonight", {
      message: `No legacy routine row exists for Day ${cycle.nightNumber}.`
    });
  }

  return {
    today,
    mode,
    cycle,
    assignment: {
      ...buildAssignmentMetadata(null, {
        dayNumber: tonightRecord.day
      }),
      id: tonightRecord.id,
      date: today,
      nightLabel: tonightRecord.day ? `Day ${String(tonightRecord.day).padStart(2, "0")}` : "",
      nightOrder: tonightRecord.day || null,
      overridden: false
    },
    routine: {
      blockName: tonightRecord.blockName,
      treatmentName: tonightRecord.devices[0] || null,
      devices: tonightRecord.devices,
      note: routineNote(tonightRecord),
      sections: buildLegacyRoutineSections(tonightRecord)
    },
    next: await resolveNextFromLegacy(env, cycle.nightNumber + 1, addDays(today, 1))
  };
}

function canFallbackToLegacy(env, error) {
  if (!env.LEGACY_ROUTINE_DB_ID) return false;
  if (!(error instanceof HttpError)) return false;
  if (error.status === 404) return true;
  if (error.status !== 409) return false;

  const message = error.details?.message || "";
  return /found 0/.test(message);
}

async function resolveTonightPayload(env) {
  const today = dateStringInZone(new Date(), USER_TIME_ZONE);
  const mode = await getMode(env);
  const cycle = await resolveActiveCycle(env, today);

  if (mode === "travel" || mode === "minimal") {
    return resolveOverridePayload(env, today, cycle, mode);
  }

  if (cycle.source === "normalized") {
    try {
      return await resolveNormalizedTonightPayload(env, today, cycle, mode);
    } catch (error) {
      if (canFallbackToLegacy(env, error)) {
        const legacyCycle = env.LEGACY_CYCLES_DB_ID
          ? { ...(await resolveActiveCycleFromLegacy(env, today)), source: "legacy-fallback" }
          : cycle;
        return resolveLegacyTonightPayload(env, today, legacyCycle, mode);
      }
      throw error;
    }
  }

  return resolveLegacyTonightPayload(env, today, cycle, mode);
}

async function resolveRoutineAssignmentPayload(env, assignmentId, requestedMode) {
  if (!assignmentId) {
    throw new HttpError(400, "Missing nightly assignment id", {
      message: "A nightly assignment id is required to preview a selected night."
    });
  }

  const today = dateStringInZone(new Date(), USER_TIME_ZONE);
  const mode = normalizeMode(requestedMode || (await getMode(env)));
  const cycle = await resolveActiveCycle(env, today);
  const assignment = await resolveAssignmentById(env, assignmentId);
  const assignments = await resolveAllAssignments(env);
  const assignmentIndex = assignments.findIndex((item) => item.id === assignment.id);

  if (assignmentIndex === -1) {
    throw new HttpError(404, "Nightly assignment not found", {
      message: "The selected nightly assignment could not be found in the Skincare plan."
    });
  }

  const nextAssignment = assignments[assignmentIndex + 1] || null;

  if (mode === "travel" || mode === "minimal") {
    return {
      ok: true,
      ...(
        await resolveOverridePayloadForAssignment(
          env,
          today,
          cycle,
          mode,
          assignment,
          nextAssignment
        )
      )
    };
  }

  return {
    ok: true,
    ...(
      await resolveNormalizedPayloadForAssignment(
        env,
        today,
        cycle,
        mode,
        assignment,
        nextAssignment
      )
    )
  };
}

async function resolveActiveCycleFromLegacy(env, today) {
  const legacyCycles = await queryActiveCycles(env, env.LEGACY_CYCLES_DB_ID, today);
  if (legacyCycles.length !== 1) {
    throw new HttpError(409, "Cycle configuration error", {
      message: `Expected exactly one active legacy cycle for ${today}, found ${legacyCycles.length}.`,
      cycles: legacyCycles
    });
  }

  return legacyCycles[0];
}

async function handleTonight(env) {
  const [tonight, yesterday] = await Promise.all([resolveTonightPayload(env), resolveYesterdayPayload(env)]);
  return {
    ok: true,
    ...tonight,
    yesterday
  };
}

async function readRequestBody(request) {
  if (request.headers.get("Content-Type")?.includes("application/json")) {
    return request.json();
  }

  return {};
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      if (!isAllowedOrigin(origin)) {
        return new Response(null, { status: 403 });
      }
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    if (!isAllowedOrigin(origin)) {
      return jsonResponse({ ok: false, error: "Forbidden origin" }, 403, origin || DEFAULT_NOTION_ORIGIN);
    }

    const url = new URL(request.url);

    try {
      if (request.method === "GET" && url.pathname === "/api/health") {
        return jsonResponse(
          {
            ok: true,
            worker: "skincare",
            mode: await getMode(env),
            configuredDatabases: {
              cycles: env.CYCLES_DB_ID,
              nightlyAssignments: env.NIGHTLY_ASSIGNMENTS_DB_ID,
              stepGroups: env.STEP_GROUPS_DB_ID,
              steps: env.STEPS_DB_ID,
              products: env.PRODUCTS_DB_ID,
              dailyLogs: env.DAILY_LOGS_DB_ID,
              exceptions: env.EXCEPTIONS_DB_ID,
              weeklyReviews: env.WEEKLY_REVIEWS_DB_ID,
              skinStatusLogs: env.SKIN_STATUS_DB_ID,
              legacyCycles: env.LEGACY_CYCLES_DB_ID,
              legacyRoutine: env.LEGACY_ROUTINE_DB_ID,
              legacyDailyLogs: env.LEGACY_DAILY_LOGS_DB_ID
            }
          },
          200,
          origin
        );
      }

      if (request.method === "GET" && url.pathname === "/api/mode") {
        return jsonResponse({ ok: true, mode: await getMode(env) }, 200, origin);
      }

      if (request.method === "PUT" && url.pathname === "/api/mode") {
        const body = await readRequestBody(request);
        const mode = await setMode(env, body.mode);
        return jsonResponse({ ok: true, mode }, 200, origin);
      }

      if (request.method === "GET" && url.pathname === "/api/cycle") {
        const today = dateStringInZone(new Date(), USER_TIME_ZONE);
        return jsonResponse(
          {
            ok: true,
            mode: await getMode(env),
            cycle: await resolveActiveCycle(env, today)
          },
          200,
          origin
        );
      }

      if (request.method === "GET" && url.pathname === "/api/tonight") {
        return jsonResponse(await handleTonight(env), 200, origin);
      }

      if (request.method === "GET" && url.pathname === "/api/routine-plan") {
        return jsonResponse(await resolveRoutinePlanPayload(env), 200, origin);
      }

      if (request.method === "GET" && url.pathname === "/api/routine-assignment") {
        return jsonResponse(
          await resolveRoutineAssignmentPayload(
            env,
            url.searchParams.get("id"),
            url.searchParams.get("mode")
          ),
          200,
          origin
        );
      }

      if (request.method === "GET" && url.pathname === "/api/yesterday") {
        return jsonResponse({ ok: true, ...(await resolveYesterdayPayload(env)) }, 200, origin);
      }

      if (request.method === "POST" && ["/api/exception", "/api/note", "/api/weekly-review", "/api/incident"].includes(url.pathname)) {
        return jsonResponse(
          {
            ok: false,
            error: "This endpoint is scaffolded but not wired to a live Notion destination yet.",
            path: url.pathname
          },
          501,
          origin
        );
      }

      return jsonResponse({ ok: false, error: "Not found" }, 404, origin);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const details = error instanceof HttpError ? error.details : { message: error.message };
      return jsonResponse(
        {
          ok: false,
          error: error.message || "Unexpected error",
          details
        },
        status,
        origin
      );
    }
  },

  async scheduled(event) {
    console.log(`Scheduled trigger received for ${event.cron}. Skincare auto-submit wiring comes next.`);
  }
};
