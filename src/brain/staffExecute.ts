/**
 * Executes staff-mode tools against the DB. Mirrors executeTool.ts but for the
 * workforce side (clock in/out, hours, leave). Returns plain data the staff brain
 * turns into a natural reply.
 */
import {
  clockIn, clockOut, getOpenTimeEntry, getStaffTimeEntries, createLeaveRequest,
  addTask, addExpense,
} from '../db';
import { sumHours, startOfWeek, formatHours, leaveDays } from '../lib/teamOps';
import { sendProactiveWhatsApp } from '../lib/twilio';

export async function executeStaffTool(
  clinic: any,
  staff: any,
  name: string,
  input: any,
): Promise<unknown> {
  switch (name) {
    case 'clock_in': {
      const r = await clockIn(staff.id, clinic.id);
      if (!r.ok) return { error: 'already_clocked_in', message: "You're already clocked in." };
      return { ok: true, clocked_in_at: r.clock_in };
    }
    case 'clock_out': {
      const r = await clockOut(staff.id);
      if (!r.ok) return { error: 'not_clocked_in', message: "You're not currently clocked in." };
      const hrs = sumHours([{ clock_in: r.clock_in, clock_out: r.clock_out }]);
      return { ok: true, clocked_out_at: r.clock_out, shift_length: formatHours(hrs) };
    }
    case 'get_my_hours': {
      const since = new Date(startOfWeek()).toISOString();
      const entries = await getStaffTimeEntries(staff.id, since);
      const total = sumHours(entries);
      const open = await getOpenTimeEntry(staff.id);
      return { week_hours: formatHours(total), currently_clocked_in: !!open };
    }
    case 'request_leave': {
      const start = String(input?.start_date ?? '');
      const end = String(input?.end_date ?? start);
      if (!start) return { error: 'no_dates', message: 'Please give the date(s) you want off.' };
      const days = leaveDays(start, end);
      if (days < 1) return { error: 'bad_dates', message: 'Those dates don’t look right — can you confirm them?' };
      await createLeaveRequest(staff.id, clinic.id, {
        start_date: start, end_date: end, type: input?.type, reason: input?.reason,
      });
      // Notify the owner so they can approve (best-effort; never blocks the reply).
      try {
        const owner = clinic.owner_summary_phone || clinic.escalation_contact;
        if (owner) {
          await sendProactiveWhatsApp(owner, {
            fallbackBody: `🗓️ Leave request from ${staff.name}: ${start}${end !== start ? ` → ${end}` : ''} (${days} day${days > 1 ? 's' : ''}, ${input?.type || 'annual'})${input?.reason ? ` — ${input.reason}` : ''}. Approve in the Team Ops dashboard.`,
          });
        }
      } catch { /* non-blocking */ }
      return { ok: true, days, status: 'pending', message: 'Leave request submitted for approval.' };
    }
    case 'add_task': {
      const title = String(input?.title ?? '').trim();
      if (!title) return { error: 'no_title', message: 'What should the task say?' };
      await addTask(clinic.id, { title, due_at: input?.due_at, source: 'whatsapp-staff', assignee: staff.name });
      return { ok: true, message: 'Added to the task list.' };
    }
    case 'log_expense': {
      const amount = Number(input?.amount_zar);
      if (!amount || amount <= 0) return { error: 'bad_amount', message: 'How much was the expense?' };
      await addExpense(clinic.id, { amount_zar: amount, description: input?.description, category: input?.category, logged_by: staff.name });
      return { ok: true, amount_zar: amount, message: `Logged R${amount}.` };
    }
    default:
      return { error: 'unknown_tool' };
  }
}
