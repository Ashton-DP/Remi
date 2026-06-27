import Anthropic from '@anthropic-ai/sdk';

/** Tools Remi can call. The orchestrator (executeTool) owns all side effects. */
export const tools: Anthropic.Tool[] = [
  // (get_services removed — the full service list + prices are already in the
  // system prompt, so a tool call just added a wasted round-trip of latency.)
  {
    name: 'check_availability',
    description:
      'Find open appointment slots on a given date for a service. Returns ISO datetime slots.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD' },
        service: { type: 'string', description: 'Treatment name' },
      },
      required: ['date'],
    },
  },
  {
    name: 'create_booking',
    description:
      'Book an appointment AFTER the client has confirmed the treatment, date, time, and given their name.',
    input_schema: {
      type: 'object',
      properties: {
        client_name: { type: 'string' },
        service: { type: 'string' },
        start_at: { type: 'string', description: 'ISO datetime of the chosen slot' },
      },
      required: ['client_name', 'service', 'start_at'],
    },
  },
  {
    name: 'reschedule_booking',
    description:
      "Move the client's upcoming confirmed booking to a new time. Call check_availability first, confirm the new slot with the client, then call this.",
    input_schema: {
      type: 'object',
      properties: {
        new_start_at: { type: 'string', description: 'ISO datetime of the new slot' },
      },
      required: ['new_start_at'],
    },
  },
  {
    name: 'cancel_booking',
    description:
      "Cancel the client's upcoming confirmed booking. Always confirm they mean to cancel before calling this.",
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Optional reason given by the client' },
      },
    },
  },
  {
    name: 'add_to_waitlist',
    description:
      'Add the client to the waitlist for a service when no slot is available. They will be texted automatically when a cancellation opens up.',
    input_schema: {
      type: 'object',
      properties: {
        service: { type: 'string' },
        preferred_window: {
          type: 'string',
          description: 'e.g. "mornings", "Friday afternoon", "any time"',
        },
      },
      required: ['service'],
    },
  },
  {
    name: 'get_daily_brief',
    description:
      "Get today's appointment schedule, waitlist, and overdue invoices for the clinic owner. Call this when the owner asks how their day looks, what's on the agenda, or for a daily summary.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'escalate_to_human',
    description:
      'Flag the conversation for a human when you cannot safely handle it (complex, sensitive, upset, or clinical).',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string' },
        summary: { type: 'string' },
      },
      required: ['reason'],
    },
  },
  {
    name: 'take_message',
    description:
      "Take a message for the clinic team when the caller wants to pass something on or be called back, and it's not a booking you can handle yourself (e.g. 'ask Dr Smith to call me about my results', 'let reception know I'll be late'). It goes on the team's task list for a human to action.",
    input_schema: {
      type: 'object',
      properties: {
        for_whom: { type: 'string', description: 'Who the message is for (a person or "reception"), if stated' },
        message: { type: 'string', description: "The message to pass on, in the caller's words" },
        callback_wanted: { type: 'boolean', description: 'True if they want someone to call/message them back' },
      },
      required: ['message'],
    },
  },
  {
    name: 'check_package',
    description:
      "Check how many prepaid sessions the client has left on their active package. Call when they ask 'how many sessions do I have left?', 'what's left on my package?', or similar.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'check_membership',
    description:
      "Check the client's membership/subscription status and next renewal date. Call when they ask 'am I a member?', 'when does my plan renew?', or about their subscription.",
    input_schema: { type: 'object', properties: {} },
  },
];
