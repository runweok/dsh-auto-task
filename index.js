/**
 * Model-facing `auto_task` tool over the Host `ctx.schedule` service.
 *
 * Compiles plain schedule descriptions — once / daily / weekly / interval /
 * cron / delayed — into exact schedule timing selectors and creates tasks in
 * batch, so the model never has to author an RRULE. Also previews the
 * compiled requests without creating (action=plan) and removes all ended
 * tasks in one batch (action=cleanup).
 *
 * The module is intentionally import-free: everything (tool registry,
 * schedule service) is reached through the Cordis context, so the bundle
 * works as a workspace-linked profile package without harness-package
 * resolution.
 * @module @local/auto-task
 */

/** Plugin name registered with the Loader. */
const name = "auto-task";
/** Host services this plugin consumes; the plugin stays inert without them. */
const inject = ["tools"];

/** Default zone for once/daily/weekly/cron rules when the caller omits one. */
const DEFAULT_TIME_ZONE = "Asia/Shanghai";
/** Delivery target choices, same vocabulary as the built-in schedule tools. */
const TARGET_CHOICES = ["this_session", "new_once", "new"];
/** Per-call task batch cap. */
const MAX_TASKS_PER_CALL = 10;
/** Task title cap of the schedule service. */
const MAX_TITLE_LENGTH = 120;
/** Minimum recurrence interval (seconds) of the schedule service. */
const MIN_EVERY_INTERVAL_SECONDS = 60;

const DESCRIPTION = [
	"自动化任务构建器：把平铺的时间描述确定性编译成 DSH 定时任务并批量创建，无需手写 RRULE。",
	"action=create 创建 tasks 里的全部任务（逐条返回结果，单条失败不影响其他）；",
	"action=plan 只编译校验并返回将要提交的请求，不创建——拿不准时间规则时先用 plan 与用户确认；",
	"action=list 列出当前全部任务（可按 active 过滤，返回每条的规则与下次触发时刻）；",
	"action=edit 按 id 批量修改已有任务（标题/指令/时间规则/目标/暂停恢复/删除），时间规则同样用 when 描述，无需 RRULE；",
	"action=cleanup 一键删除全部已结束（ended）任务。",
	"when 规则六选一：once=指定日期时间执行一次；daily=每天固定时刻；weekly=每周固定星期几；every=固定间隔循环（分钟，≥1）；cron=五段 Vixie 表达式；after=延迟 N 分钟执行一次。",
	"时区缺省 Asia/Shanghai；target 缺省 new_once（第一次触发时创建一个独立会话并复用）；提醒当前会话用 this_session；每次都要全新会话用 new。",
	"只有用户明确要求时才创建或修改定时任务；对正在运行的定时任务，用户先前明确授权过的操作仍然有效；委派的子代理不能调用本工具。"
].join("");

/* ------------------------------------------------------------------ */
/* Compile: plain `when` descriptors -> exact schedule timing selectors */
/* ------------------------------------------------------------------ */

const WEEKDAY_NAMES = {
	"一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "日": 7, "天": 7,
	mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, weds: 3, wednesday: 3,
	thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5,
	sat: 6, saturday: 6, sun: 7, sunday: 7
};

/** Build a structured input error whose code survives per-item mapping. */
function inputError(code, message) {
	const error = new Error(message);
	error.code = code;
	return error;
}

/** Whether an unknown thrown value carries a readable code/message pair. */
function isStructuredError(error) {
	return error !== null && typeof error === "object"
		&& typeof error.code === "string" && typeof error.message === "string";
}

/** Delegation depth of the calling agent, matching dsh-subagent accounting. */
function delegationDepthOf(agent) {
	const headerDepth = agent?.session?.header?.delegationDepth;
	const runtimeDepth = agent?.options?.subagentDepth;
	return Math.max(
		typeof headerDepth === "number" && Number.isSafeInteger(headerDepth) && headerDepth > 0 ? headerDepth : 0,
		typeof runtimeDepth === "number" && Number.isSafeInteger(runtimeDepth) && runtimeDepth > 0 ? runtimeDepth : 0
	);
}

/**
 * Normalize `HH:mm` / `HH:mm:ss` / `HH:mm:ss.fraction` into the strict
 * `HH:mm:ss[.fraction]` the schedule service expects.
 */
function normalizeTime(input, label = "time") {
	if (typeof input !== "string") throw inputError("invalid_input", `${label} 必须是 HH:mm 或 HH:mm:ss 字符串。`);
	const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.(\d{1,3}))?$/.exec(input.trim());
	if (match === null) throw inputError("invalid_input", `无法识别的${label}「${input}」：请用 24 小时制 HH:mm 或 HH:mm:ss。`);
	const hour = Number(match[1]);
	const minute = Number(match[2]);
	const second = match[3] === undefined ? 0 : Number(match[3]);
	if (hour > 23 || minute > 59 || second > 59) throw inputError("invalid_input", `${label}「${input}」超出范围（24 小时制，分秒 0–59）。`);
	const fraction = match[4] === undefined ? "" : `.${match[4]}`;
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}:${String(second).padStart(2, "0")}${fraction}`;
}

/** Validate and normalize a local calendar date. */
function normalizeDate(input) {
	if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.trim())) {
		throw inputError("invalid_input", `date「${input === undefined ? "" : input}」格式不对：必须是 YYYY-MM-DD。`);
	}
	return input.trim();
}

/** Parse weekday entries (1–7, 中文「周一/周三/周日/一/日」, or mon..sun) into unique ascending ISO numbers. */
function parseWeekdays(input) {
	if (!Array.isArray(input) || input.length === 0) {
		throw inputError("invalid_input", "weekly.weekdays 必须是非空数组：1–7（周一=1）、「周一」…「周日」或 mon..sun。");
	}
	const unique = new Set();
	for (const entry of input) {
		let value;
		if (typeof entry === "number" && Number.isInteger(entry) && entry >= 1 && entry <= 7) {
			value = entry;
		} else if (typeof entry === "string") {
			const raw = entry.trim().toLowerCase();
			if (/^[1-7]$/.test(raw)) {
				value = Number(raw);
			} else {
				const stripped = raw.replace(/^(周|星期|礼拜)/u, "");
				value = WEEKDAY_NAMES[stripped] ?? WEEKDAY_NAMES[raw];
			}
		}
		if (value === undefined) {
			throw inputError("invalid_input", `无法识别的星期「${String(entry)}」：可用 1–7（周一=1）、「周一」…「周日」或 mon..sun。`);
		}
		unique.add(value);
	}
	return [...unique].sort((left, right) => left - right);
}

/**
 * Compile one `when` descriptor into the exact management timing selector.
 * The selector key must equal the kind name (after/every use their
 * snake_case selector keys), matching the service's exact-key validation.
 */
function compileWhen(when, timeZone) {
	if (when === null || typeof when !== "object") {
		throw inputError("invalid_input", "when 必须是带 freq 的对象（once/daily/weekly/every/cron/after）。");
	}
	switch (when.freq) {
		case "once": {
			const date = normalizeDate(when.date);
			const time = normalizeTime(when.time);
			return { kind: "at", at: { date, time, time_zone: timeZone } };
		}
		case "daily":
			return { kind: "daily", daily: { time: normalizeTime(when.time), time_zone: timeZone } };
		case "weekly":
			return {
				kind: "weekly",
				weekly: {
					time: normalizeTime(when.time),
					time_zone: timeZone,
					weekdays: parseWeekdays(when.weekdays)
				}
			};
		case "cron": {
			if (typeof when.expression !== "string" || when.expression.trim() === "") {
				throw inputError("invalid_input", "cron.expression 必须是五段 Vixie cron 表达式，如 \"*/15 9-17 * * 1-5\"。");
			}
			return { kind: "cron", cron: { expression: when.expression.trim(), time_zone: timeZone } };
		}
		case "every": {
			const minutes = when.minutes;
			if (!Number.isInteger(minutes) || minutes < 1 || minutes * 60 < MIN_EVERY_INTERVAL_SECONDS) {
				throw inputError("invalid_rule", `every.minutes 必须是 ≥${Math.ceil(MIN_EVERY_INTERVAL_SECONDS / 60)} 的整数分钟（调度服务最小间隔 ${MIN_EVERY_INTERVAL_SECONDS} 秒）。`);
			}
			return { kind: "every", every_seconds: minutes * 60 };
		}
		case "after": {
			const minutes = when.minutes;
			if (!Number.isInteger(minutes) || minutes <= 0) {
				throw inputError("invalid_input", "after.minutes 必须是 >0 的整数分钟。");
			}
			return { kind: "after", after_seconds: minutes * 60 };
		}
		case undefined:
			throw inputError("invalid_input", "when.freq 缺失：once/daily/weekly/every/cron/after 六选一。");
		default:
			throw inputError("invalid_input", `未知的 when.freq「${String(when.freq)}」：once/daily/weekly/every/cron/after 六选一。`);
	}
}

/**
 * Resolve one target choice to a delivery destination, mirroring the
 * built-in schedule tools: created sessions reuse the caller's working
 * directory and composed preset.
 */
function targetFor(agent, target) {
	if (target === "this_session") return { kind: "session", sessionId: agent.session.id };
	const cwd = agent?.session?.header?.cwd;
	const agentPreset = agent?.ctx?.get?.("agentPresets")?.composedPreset?.(agent.ctx);
	return {
		kind: target,
		create: {
			...cwd === undefined ? {} : { cwd },
			...agentPreset === undefined ? {} : { agentPreset }
		}
	};
}

/** Compile one task entry into { title, timing, target, request }. */
function compileTask(entry, index, timeZone, defaultTarget, agent) {
	const label = `第 ${index + 1} 条任务`;
	if (entry === null || typeof entry !== "object") {
		throw inputError("invalid_input", `${label} 必须是对象（title/prompt/when/target）。`);
	}
	if (typeof entry.title !== "string" || entry.title.trim() === "") {
		throw inputError("invalid_input", `${label} 缺少 title（用户语言的任务名：动词+对象）。`);
	}
	const title = entry.title.trim();
	if (title.length > MAX_TITLE_LENGTH) {
		throw inputError("invalid_input", `${label} 的 title 超过 ${MAX_TITLE_LENGTH} 字，请精简。`);
	}
	if (typeof entry.prompt !== "string" || entry.prompt.trim() === "") {
		throw inputError("invalid_input", `${label} 缺少 prompt（每次触发时投递给目标会话的完整指令）。`);
	}
	const timing = compileWhen(entry.when, timeZone);
	const target = entry.target === undefined ? defaultTarget : entry.target;
	if (!TARGET_CHOICES.includes(target)) {
		throw inputError("invalid_input", `${label} 的 target 必须是 ${TARGET_CHOICES.join("/")} 之一。`);
	}
	return { title, timing, target, request: { title, prompt: entry.prompt, timing, target: targetFor(agent, target) } };
}

/* ------------------------------------------------------------------ */
/* Local-time rendering (mirrors the service's authoritative zone)     */
/* ------------------------------------------------------------------ */

/** The authoritative zone of a compiled task record; elapsed rules use UTC. */
function zoneOfTask(task) {
	if (typeof task?.timeZone === "string") return task.timeZone;
	if (typeof task?.rrule === "string") {
		const match = /TZID=([^:\n;]+)/.exec(task.rrule);
		if (match !== null) return match[1];
	}
	return "UTC";
}

/** Render one UTC instant as `YYYY-MM-DD HH:mm:ss` in the task's zone. */
function formatLocal(instant, timeZone) {
	if (typeof instant !== "string") return "";
	const parts = new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
		hour: "2-digit",
		minute: "2-digit",
		second: "2-digit",
		hourCycle: "h23"
	}).formatToParts(new Date(instant));
	const get = (type) => parts.find((part) => part.type === type)?.value ?? "";
	return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
}

/** Keep timing, destination, and revision while withholding host bookkeeping. */
function modelTask(task) {
	const { involvedSessionIds, createdAt, executionActive, deliveryFloorEndsAt, lastDelivery, ...record } = task;
	let scheduledAtLocal;
	try {
		scheduledAtLocal = formatLocal(task.scheduledAt, zoneOfTask(task));
	} catch {
		scheduledAtLocal = "";
	}
	return {
		...record,
		scheduledAtLocal,
		...(lastDelivery === undefined ? {} : {
			lastDelivery: {
				scheduledAt: lastDelivery.scheduledAt,
				deliveredAt: lastDelivery.deliveredAt,
				targetSessionId: lastDelivery.targetSessionId
			}
		})
	};
}

/* ------------------------------------------------------------------ */
/* Schemas (final JSON Schema, registry-facing)                       */
/* ------------------------------------------------------------------ */

const TIME_DESCRIPTION = "本地时间 HH:mm 或 HH:mm:ss（24 小时制）";

const WHEN_SCHEMA = { oneOf: [
	{
		type: "object",
		additionalProperties: false,
		properties: {
			freq: { type: "string", enum: ["once"], description: "一次性：指定日期时间执行一次" },
			date: { type: "string", description: "本地日期 YYYY-MM-DD" },
			time: { type: "string", description: TIME_DESCRIPTION }
		},
		required: ["freq", "date", "time"]
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			freq: { type: "string", enum: ["daily"], description: "每天固定时刻" },
			time: { type: "string", description: TIME_DESCRIPTION }
		},
		required: ["freq", "time"]
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			freq: { type: "string", enum: ["weekly"], description: "每周固定星期几的固定时刻" },
			weekdays: {
				type: "array",
				description: "星期几列表：1–7 整数（周一=1）、「周一」「周三」「周日」「一」「日」或 mon..sun；自动去重升序",
				items: { oneOf: [
					{ type: "integer", enum: [1, 2, 3, 4, 5, 6, 7] },
					{ type: "string" }
				] }
			},
			time: { type: "string", description: TIME_DESCRIPTION }
		},
		required: ["freq", "weekdays", "time"]
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			freq: { type: "string", enum: ["every"], description: "固定间隔循环触发" },
			minutes: { type: "integer", description: "间隔分钟数（≥1 分钟）" }
		},
		required: ["freq", "minutes"]
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			freq: { type: "string", enum: ["cron"], description: "五段 Vixie cron 表达式（进阶，时区用调用级 timeZone）" },
			expression: { type: "string", description: "如 \"*/15 9-17 * * 1-5\"" }
		},
		required: ["freq", "expression"]
	},
	{
		type: "object",
		additionalProperties: false,
		properties: {
			freq: { type: "string", enum: ["after"], description: "延迟一段时间后执行一次" },
			minutes: { type: "integer", description: "延迟分钟数（>0）" }
		},
		required: ["freq", "minutes"]
	}
] };

const TASK_INPUT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		title: { type: "string", description: `任务名，≤${MAX_TITLE_LENGTH} 字，用户语言、动词+对象；不含时间、状态、id` },
		prompt: { type: "string", description: "每次触发时投递给目标会话的指令，写成可独立执行的完整指令" },
		when: { ...WHEN_SCHEMA, description: "时间规则，六种 freq 之一" },
		target: { type: "string", enum: TARGET_CHOICES, description: "投递目标；缺省用调用级 target" }
	},
	required: ["title", "prompt", "when"]
};

const TASK_SUMMARY_SCHEMA = {
	type: "object",
	properties: {
		id: { type: "string", description: "任务 id" },
		title: { type: "string" },
		status: { type: "string", enum: ["active", "paused", "ended"] },
		scheduledAt: { type: "string", description: "下次触发时刻（UTC）" },
		scheduledAtLocal: { type: "string", description: "下次触发时刻（任务时区本地时间）" }
	},
	required: ["id", "title", "status", "scheduledAt", "scheduledAtLocal"]
};

const TASK_RESULT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		index: { type: "integer", description: "在 tasks 里的下标，从 0 开始" },
		ok: { type: "boolean", const: true },
		task: { ...TASK_SUMMARY_SCHEMA }
	},
	required: ["index", "ok", "task"]
};

const ITEM_ERROR_CODES = [
	"invalid_input",
	"invalid_prompt",
	"invalid_rule",
	"invalid_time_zone",
	"not_future",
	"frequency_too_high",
	"schedule_not_found",
	"schedule_conflict",
	"internal_error"
];

const ITEM_ERROR_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		index: { type: "integer" },
		ok: { type: "boolean", const: false },
		code: { type: "string", enum: ITEM_ERROR_CODES },
		message: { type: "string" }
	},
	required: ["index", "ok", "code", "message"]
};

const PLAN_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: { type: "string", const: "plan" },
		timeZone: { type: "string" },
		tasks: {
			type: "array",
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					index: { type: "integer" },
					title: { type: "string" },
					timing: { type: "object", description: "编译后的 timing 请求体（即将原样提交给调度服务）" },
					target: { type: "string", enum: TARGET_CHOICES }
				},
				required: ["index", "title", "timing", "target"]
			}
		}
	},
	required: ["action", "timeZone", "tasks"]
};

const CREATE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: { type: "string", const: "create" },
		created: { type: "integer", description: "成功创建的任务数" },
		failed: { type: "integer", description: "失败的任务数" },
		results: { type: "array", items: { oneOf: [TASK_RESULT_SCHEMA, ITEM_ERROR_SCHEMA] } }
	},
	required: ["action", "created", "failed", "results"]
};

const LIST_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: { type: "string", const: "list" },
		total: { type: "integer", description: "符合条件的任务总数" },
		shown: { type: "integer", description: "本页返回的任务数" },
		items: { type: "array", items: TASK_SUMMARY_SCHEMA }
	},
	required: ["action", "total", "shown", "items"]
};

const EDIT_DELETED_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		index: { type: "integer", description: "在 updates 里的下标，从 0 开始" },
		ok: { type: "boolean", const: true },
		deleted: { type: "boolean", const: true, description: "该条为删除操作且已成功" }
	},
	required: ["index", "ok", "deleted"]
};

const EDIT_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: { type: "string", const: "edit" },
		changed: { type: "integer", description: "成功修改/删除的任务数" },
		failed: { type: "integer", description: "失败的修改条数" },
		results: { type: "array", items: { oneOf: [TASK_RESULT_SCHEMA, EDIT_DELETED_SCHEMA, ITEM_ERROR_SCHEMA] } }
	},
	required: ["action", "changed", "failed", "results"]
};

const CLEANUP_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		action: { type: "string", const: "cleanup" },
		deleted: { type: "integer", description: "删除的已结束任务数量" }
	},
	required: ["action", "deleted"]
};

/** Whole-call failures: a delegated caller, a bad batch, or a withheld failure. */
const CALLER_ERROR_SCHEMA = {
	type: "object",
	additionalProperties: false,
	properties: {
		code: { type: "string", enum: ["invalid_input", "subagent_session", "internal_error"] },
		message: { type: "string" }
	},
	required: ["code", "message"]
};

const OUTPUT_SCHEMA = { oneOf: [PLAN_SCHEMA, CREATE_SCHEMA, LIST_SCHEMA, EDIT_SCHEMA, CLEANUP_SCHEMA, CALLER_ERROR_SCHEMA] };

const PARAMETERS_SCHEMA = {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["create", "plan", "list", "edit", "cleanup"],
			description: "create=创建；plan=只编译校验并返回将要提交的请求（不创建，拿不准先 plan）；list=列出全部任务；edit=按 id 批量修改已有任务；cleanup=删除全部已结束（ended）任务"
		},
		updates: {
			type: "array",
			description: `修改清单，1–${MAX_TASKS_PER_CALL} 条；action=edit 时必填，其余 action 忽略`,
			items: {
				type: "object",
				additionalProperties: false,
				properties: {
					id: { type: "string", description: "要修改的任务 id（从 list 结果里拿）" },
					title: { type: "string", description: `新任务名，≤${MAX_TITLE_LENGTH} 字` },
					prompt: { type: "string", description: "新指令（每次触发投递的内容）" },
					when: { ...WHEN_SCHEMA, description: "新时间规则（六种 freq 之一，替换整个规则；无 RRULE）" },
					target: { type: "string", enum: TARGET_CHOICES, description: "新投递目标（提供即替换，new_once 会换新会话）" },
					active: { type: "boolean", description: "false=暂停；true=恢复（需仍有未来触发时刻，否则要连 when 一起给）" },
					remove: { type: "boolean", description: "true=删除该任务（与其他字段互斥）；删除不会撤回已投递的消息" },
					expectedUpdatedAt: { type: "string", description: "乐观锁：最近一次结果里的 updatedAt；期间任务被改过则该条返回 schedule_conflict" }
				},
				required: ["id"]
			}
		},
		active: {
			type: "boolean",
			description: "仅 action=list：true 只看进行中；false 只看已暂停/已结束；缺省返回全部"
		},
		tasks: {
			type: "array",
			description: `任务清单，1–${MAX_TASKS_PER_CALL} 条；action=create/plan 时必填，cleanup 时忽略`,
			items: TASK_INPUT_SCHEMA
		},
		target: {
			type: "string",
			enum: TARGET_CHOICES,
			description: "调用级默认投递目标，缺省 new_once（第一次触发时创建独立会话并复用，适合定时报告等独立工作）。this_session=投回当前会话（提醒、跟进当前对话）；new=每次触发都开全新会话"
		},
		timeZone: {
			type: "string",
			description: "IANA 时区，作用于全部任务的 once/daily/weekly/cron 规则；缺省 Asia/Shanghai"
		}
	},
	required: ["action"]
};

/* ------------------------------------------------------------------ */
/* Rendering and failure mapping                                      */
/* ------------------------------------------------------------------ */

/** Deterministic model content: canonical JSON of the returned value. */
function renderValue(_args, value) {
	return [{ type: "text", text: JSON.stringify(value) }];
}

/** Map one per-item failure to a declared code, withholding undeclared detail. */
function itemError(error, index) {
	if (isStructuredError(error) && ITEM_ERROR_CODES.includes(error.code)) {
		return { index, ok: false, code: error.code, message: error.message };
	}
	return { index, ok: false, code: "internal_error", message: "该任务未能创建。" };
}

/** Stable whole-call error for failures not safe to expose. */
function internalError() {
	return { code: "internal_error", message: "自动化任务操作失败。" };
}

/**
 * Run one operation for the root Agent that dispatched the call. A delegated
 * subagent cannot manage scheduled tasks, mirroring the built-in tools.
 */
async function runForCaller(exec, codes, operation) {
	const agent = exec?.agent;
	if (agent === undefined) return internalError();
	if (delegationDepthOf(agent) > 0) {
		return { code: "subagent_session", message: "委派的子代理不能使用定时任务。" };
	}
	try {
		return await operation(agent);
	} catch (error) {
		if (isStructuredError(error) && codes.includes(error.code)) {
			return { code: error.code, message: error.message };
		}
		return internalError();
	}
}

/** Pure generic pending card. */
function present(title, kind, rawInput) {
	return {
		card: "generic",
		title,
		kind,
		...(rawInput === undefined ? {} : { rawInput })
	};
}

/* ------------------------------------------------------------------ */
/* Plugin entry                                                       */
/* ------------------------------------------------------------------ */

/** Whole-call codes this tool can surface. */
const CALLER_CODES = ["invalid_input", "subagent_session", "internal_error"];

/** Register the auto_task tool in the scope that resolved the schedule service. */
function registerAutoTaskTool(ctx) {
	ctx.tools.register({
		name: "auto_task",
		description: DESCRIPTION,
		parameters: PARAMETERS_SCHEMA,
		output: {
			schema: OUTPUT_SCHEMA,
			render: renderValue
		},
		async execute(args, exec) {
			return runForCaller(exec, CALLER_CODES, async (agent) => {
				const action = args?.action;
				if (action === "cleanup") {
					const { deleted } = await ctx.schedule.deleteInactive();
					return { action: "cleanup", deleted };
				}
				if (action === "list") {
					const active = args?.active;
					const page = await ctx.schedule.list(active === undefined ? {} : { active });
					return {
						action: "list",
						total: page.total,
						shown: page.shown,
						items: page.items.map(modelTask)
					};
				}
				if (action === "edit") {
					const updates = args?.updates;
					if (!Array.isArray(updates) || updates.length === 0) {
						throw inputError("invalid_input", `updates 必须是 1–${MAX_TASKS_PER_CALL} 条修改的非空数组（action=edit 时必填）。`);
					}
					if (updates.length > MAX_TASKS_PER_CALL) {
						throw inputError("invalid_input", `一次最多修改 ${MAX_TASKS_PER_CALL} 条，更多请分批调用。`);
					}
					const timeZone = args?.timeZone === undefined ? DEFAULT_TIME_ZONE : args.timeZone;
					const results = [];
					for (let index = 0; index < updates.length; index++) {
						const entry = updates[index];
						try {
							if (entry === null || typeof entry !== "object" || typeof entry.id !== "string" || entry.id.trim() === "") {
								throw inputError("invalid_input", `第 ${index + 1} 条修改缺少 id（从 list 结果里拿）。`);
							}
							const id = entry.id.trim();
							const expected = entry.expectedUpdatedAt === undefined ? {} : { expectedUpdatedAt: entry.expectedUpdatedAt };
							if (entry.remove === true) {
								if (entry.title !== undefined || entry.prompt !== undefined || entry.when !== undefined || entry.target !== undefined || entry.active !== undefined) {
									throw inputError("invalid_input", `第 ${index + 1} 条修改：remove=true 时不能再带其他字段。`);
								}
								await ctx.schedule.edit({ id, action: "delete", ...expected }, agent.session.id, exec?.signal);
								results.push({ index, ok: true, deleted: true });
								continue;
							}
							const patch = {};
							if (entry.title !== undefined) {
								if (typeof entry.title !== "string" || entry.title.trim() === "" || entry.title.trim().length > MAX_TITLE_LENGTH) {
									throw inputError("invalid_input", `第 ${index + 1} 条修改的 title 无效（1–${MAX_TITLE_LENGTH} 字）。`);
								}
								patch.title = entry.title.trim();
							}
							if (entry.prompt !== undefined) {
								if (typeof entry.prompt !== "string" || entry.prompt.trim() === "") {
									throw inputError("invalid_input", `第 ${index + 1} 条修改的 prompt 不能为空。`);
								}
								patch.prompt = entry.prompt;
							}
							if (entry.when !== undefined) patch.timing = compileWhen(entry.when, timeZone);
							if (entry.target !== undefined) {
								if (!TARGET_CHOICES.includes(entry.target)) {
									throw inputError("invalid_input", `第 ${index + 1} 条修改的 target 必须是 ${TARGET_CHOICES.join("/")} 之一。`);
								}
								patch.target = targetFor(agent, entry.target);
							}
							if (entry.active !== undefined) {
								if (typeof entry.active !== "boolean") {
									throw inputError("invalid_input", `第 ${index + 1} 条修改的 active 必须是布尔值。`);
								}
								patch.active = entry.active;
							}
							if (Object.keys(patch).length === 0) {
								throw inputError("invalid_input", `第 ${index + 1} 条修改至少要带 title/prompt/when/target/active/remove 之一。`);
							}
							const task = await ctx.schedule.edit({ id, action: "update", patch, ...expected }, agent.session.id, exec?.signal);
							results.push({ index, ok: true, task: modelTask(task) });
						} catch (error) {
							results.push(itemError(error, index));
						}
					}
					return {
						action: "edit",
						changed: results.filter((result) => result.ok).length,
						failed: results.filter((result) => !result.ok).length,
						results
					};
				}
				if (action !== "create" && action !== "plan") {
					throw inputError("invalid_input", "action 必须是 create/plan/list/edit/cleanup 之一。");
				}
				const tasks = args?.tasks;
				if (!Array.isArray(tasks) || tasks.length === 0) {
					throw inputError("invalid_input", `tasks 必须是 1–${MAX_TASKS_PER_CALL} 条任务的非空数组（action=cleanup 不需要 tasks）。`);
				}
				if (tasks.length > MAX_TASKS_PER_CALL) {
					throw inputError("invalid_input", `一次最多构建 ${MAX_TASKS_PER_CALL} 条任务，更多请分批调用。`);
				}
				const timeZone = args?.timeZone === undefined ? DEFAULT_TIME_ZONE : args.timeZone;
				const defaultTarget = args?.target === undefined ? "new_once" : args.target;
				const compiled = tasks.map((entry, index) => compileTask(entry, index, timeZone, defaultTarget, agent));
				if (action === "plan") {
					return {
						action: "plan",
						timeZone,
						tasks: compiled.map((task, index) => ({
							index,
							title: task.title,
							timing: task.timing,
							target: task.target
						}))
					};
				}
				const results = [];
				for (let index = 0; index < compiled.length; index++) {
					const { request } = compiled[index];
					try {
						const task = await ctx.schedule.create(request, agent.session.id, exec?.signal);
						results.push({ index, ok: true, task: modelTask(task) });
					} catch (error) {
						results.push(itemError(error, index));
					}
				}
				return {
					action: "create",
					created: results.filter((result) => result.ok).length,
					failed: results.filter((result) => !result.ok).length,
					results
				};
			});
		},
		presentCall: (callArgs) => present(
			callArgs?.action === "cleanup" ? "清理已结束的定时任务"
				: callArgs?.action === "list" ? "列出自动化任务"
				: callArgs?.action === "edit" ? "编辑自动化任务"
				: callArgs?.action === "plan" ? "预览自动化任务"
				: "自动构建定时任务",
			callArgs?.action === "plan" || callArgs?.action === "list" ? "read" : "other",
			Array.isArray(callArgs?.updates)
				? callArgs.updates.map((entry) => entry?.id).filter((id) => typeof id === "string").join("、")
				: Array.isArray(callArgs?.tasks)
					? callArgs.tasks.map((task) => task?.title).filter((title) => typeof title === "string").join("、")
					: undefined
		)
	});
}

/**
 * Register the auto_task tool once the mounting scope resolves the schedule
 * service, so a preset that keeps that service off mounts nothing.
 * @param ctx - Context owning the tool registry.
 */
function apply(ctx) {
	ctx.inject(["schedule"], registerAutoTaskTool);
}

export { apply, inject, name };
