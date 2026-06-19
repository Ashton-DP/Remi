import type { Request, Response } from 'express';
import { config } from '../config';
import { getClinic, getOrCreateClient, getOrCreateConversation } from '../db';
import { executeTool } from '../brain/executeTool';

/**
 * Webhook tools the ElevenLabs voice agent calls during a call. Each maps to the
 * SAME executeTool logic the WhatsApp brain uses, so voice + WhatsApp stay in sync.
 *
 * The agent passes the caller's phone (and optionally clinic_id) so we can resolve
 * the right clinic + client; everything else (service, date, slot) the LLM fills.
 */

async function resolveContext(body: any) {
  const clinic = await getClinic(body.clinic_id || config.defaultClinicId);
  if (!clinic) throw new Error('clinic not found');
  // caller_phone identifies the client. Falls back to a demo id for the web widget.
  const phone = String(body.caller_phone || '').trim() || 'web-demo';
  const { client: customer } = await getOrCreateClient(clinic.id, phone);
  const convo = await getOrCreateConversation(clinic.id, customer.id);
  return { clinic, customer, convo };
}

// Map each tool's webhook body → the input shape executeTool expects.
const TOOL_INPUT: Record<string, (b: any) => any> = {
  get_services: () => ({}),
  check_availability: (b) => ({ date: b.date, service: b.service }),
  create_booking: (b) => ({ service: b.service, start_at: b.start_at, client_name: b.client_name }),
  reschedule_booking: (b) => ({ new_start_at: b.new_start_at }),
  cancel_booking: () => ({}),
  add_to_waitlist: (b) => ({ service: b.service, preferred_window: b.preferred_window }),
};

/** POST /tools/:tool — invoked by the ElevenLabs agent's server tools. */
export async function handleAgentTool(req: Request, res: Response) {
  const tool = String(req.params.tool);
  if (config.toolsSecret && req.header('X-Tool-Secret') !== config.toolsSecret) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const mapInput = TOOL_INPUT[tool];
  if (!mapInput) return res.status(404).json({ error: `unknown tool: ${tool}` });

  try {
    // Accept params whether ElevenLabs sends them as query string or JSON body.
    const params = { ...(req.query as any), ...(req.body as any) };
    const { clinic, customer, convo } = await resolveContext(params);
    const result = await executeTool(clinic, customer, convo, tool, mapInput(params));
    res.json(result);
  } catch (e: any) {
    console.error('[agentTools]', tool, e);
    res.status(500).json({ error: e?.message ?? 'tool failed' });
  }
}
