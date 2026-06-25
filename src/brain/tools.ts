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
];
