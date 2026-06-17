import Anthropic from '@anthropic-ai/sdk';

/** Tools Remi can call. The orchestrator (executeTool) owns all side effects. */
export const tools: Anthropic.Tool[] = [
  {
    name: 'get_services',
    description: "List the clinic's treatments, prices (ZAR) and durations.",
    input_schema: { type: 'object', properties: {} },
  },
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
