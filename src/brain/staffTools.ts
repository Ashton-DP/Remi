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
