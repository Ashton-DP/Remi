/**
 * Staff-mode tools — used only when an inbound message is from a recognised
 * staff member (matched by phone). Separate from the client booking tools so the
 * two brains never cross wires. Anthropic-style schemas; the Gemini agent maps them.
 */
export const staffTools = [
  {
    name: 'clock_in',
    description: "Clock the staff member IN for their shift. Use when they say things like 'clock in', 'I'm here', 'starting now', 'aangekom'.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'clock_out',
    description: "Clock the staff member OUT (end of shift / break). Use for 'clock out', 'going home', 'done for the day', 'klaar'.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'get_my_hours',
    description: "Report the staff member's total worked hours so far THIS WEEK, and whether they're currently clocked in.",
    input_schema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'add_task',
    description: "Add a to-do/reminder to the office task list. Use for 'remind me to…', 'add task…', 'don't forget to…'. Parse any time they mention into due_at.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task description' },
        due_at: { type: 'string', description: 'Optional ISO datetime it should be done by' },
      },
      required: ['title'],
    },
  },
  {
    name: 'log_expense',
    description: "Log a business expense. Use for 'log R450 gloves', 'spent R1200 on stock from X'. amount_zar is the rand amount as a number.",
    input_schema: {
      type: 'object',
      properties: {
        amount_zar: { type: 'number', description: 'Rand amount' },
        description: { type: 'string', description: 'What it was for' },
        category: { type: 'string', description: 'Optional category, e.g. stock/supplies/utilities' },
      },
      required: ['amount_zar'],
    },
  },
  {
    name: 'update_client_profile',
    description:
      "Update a client's profile notes, preferences, allergies, or tags. Use when a practitioner says things like 'add a note for Jane: allergic to latex', 'tag Maria as VIP', 'note that John prefers morning slots'. Provide the client's name or phone so we can match them.",
    input_schema: {
      type: 'object',
      properties: {
        client_identifier: { type: 'string', description: "Client name or phone number to look up" },
        notes: { type: 'string', description: 'Clinical / general notes to set (replaces existing)' },
        preferences: { type: 'string', description: 'Scheduling or treatment preferences' },
        allergies: { type: 'string', description: 'Known allergies or contraindications' },
        tags: { type: 'array', items: { type: 'string' }, description: "Labels like 'vip', 'referred', 'new'" },
        birthday: { type: 'string', description: 'ISO date YYYY-MM-DD' },
        anniversary: { type: 'string', description: 'ISO date YYYY-MM-DD' },
      },
      required: ['client_identifier'],
    },
  },
  {
    name: 'request_leave',
    description: "Submit a time-off / leave request for owner approval. Parse the dates the staff member gives. If they only give one day, set start and end to that same date.",
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'First day off, ISO date YYYY-MM-DD' },
        end_date: { type: 'string', description: 'Last day off (inclusive), ISO date YYYY-MM-DD' },
        type: { type: 'string', description: "annual | sick | unpaid (default annual)" },
        reason: { type: 'string', description: 'Optional short reason' },
      },
      required: ['start_date', 'end_date'],
    },
  },
];
