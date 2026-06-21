# Operator Agreement (POPIA s20–21)

> ⚠️ **Not legal advice.** This is a working template to be reviewed and finalised
> by a South African attorney before signing. Fill every `[BRACKETED]` placeholder.

**Between:**

**(1) The Responsible Party** — `[CLINIC LEGAL NAME]`, registration no. `[____]`,
of `[CLINIC ADDRESS]` ("the Clinic"); and

**(2) The Operator** — **The Visionaries (Pty) Ltd** (trading as "Remi"),
registration no. 2026/005294/07, of 34 Prestwich Street, Cape Town, Western Cape 8001
("Remi").

Effective date: `[DATE]`.

---

### 1. Purpose
Remi provides an AI front-desk service (call answering, WhatsApp messaging,
appointment booking, reminders, waitlist management and reporting) on behalf of
the Clinic. To do so, Remi processes personal information of the Clinic's
patients/customers as an **operator** under the Protection of Personal Information
Act, 2013 (POPIA). The Clinic is the **responsible party**.

### 2. Scope of processing
| | |
|---|---|
| **Data subjects** | The Clinic's patients, prospective patients and callers |
| **Categories of personal information** | Name, phone/WhatsApp number, message and call content, appointment details (service, date, time), and any information the data subject volunteers |
| **Special personal information** | The service is **not** intended to collect health information beyond the service a patient books. Remi will not solicit clinical/medical details. Any health info volunteered is treated as special personal information under s26 |
| **Nature & purpose** | Answering enquiries, booking/rescheduling/cancelling appointments, sending reminders and waitlist offers, and generating reports for the Clinic |
| **Duration** | For the term of the services agreement between the parties |

### 3. Remi's obligations as Operator (POPIA s20–21)
Remi shall:
1. Process personal information **only** with the Clinic's knowledge or authorisation and only for the purposes in clause 2 (s20(a)).
2. Treat all personal information as **confidential** and not disclose it except as required by law or authorised by the Clinic (s20(b)).
3. Implement and maintain appropriate, reasonable **technical and organisational security measures** to secure the integrity and confidentiality of personal information (s19, s21(1)), including encryption in transit, access controls, secret management, and least-privilege access.
4. **Notify the Clinic immediately** (and in any event within 48 hours) on becoming aware of any unauthorised access to or acquisition of personal information, to enable the Clinic to comply with s22 breach-notification duties.
5. **Assist** the Clinic in responding to data-subject requests (access, correction, deletion, objection) and to the Information Regulator.
6. On termination or on the Clinic's written request, **delete or return** all personal information and delete existing copies, unless retention is required by law.
7. Permit and contribute to **reasonable audits** of its processing on reasonable notice.

### 4. Sub-operators
The Clinic authorises Remi to engage the sub-operators in **Schedule A** to deliver
the service. Remi remains liable for their compliance and will impose equivalent
data-protection obligations on each.

### 5. Cross-border transfers (POPIA s72)
The Clinic acknowledges that certain sub-operators process data **outside South
Africa** (see Schedule A). Remi will only use sub-operators that are subject to
laws/binding agreements upholding principles of reasonable protection
substantially similar to POPIA, or where another s72 ground (e.g. necessity for
the contract, or data-subject consent) applies.

### 6. Liability, term & governing law
6.1 This agreement runs for the term of the parties' services agreement.
6.2 Each party complies with POPIA in respect of its role.
6.3 Liability is as set out in the services agreement.
6.4 Governed by the laws of the Republic of South Africa.

---

### Schedule A — Authorised sub-operators
| Sub-operator | Purpose | Data location | Notes |
|---|---|---|---|
| Twilio Inc. | Telephony + WhatsApp delivery | USA (+ regional) | Telecoms carrier; processes phone numbers + message/call content |
| ElevenLabs Inc. | AI voice (call answering) | USA | Speech synthesis + conversational voice agent |
| Supabase | Database (bookings, conversations) | EU (Frankfurt/Ireland) | Primary data store; EU/GDPR adequate protection |
| Google LLC (Gemini API) | Generating replies | USA | **Must be a PAID tier** — free tiers may train on data |
| Google LLC | Calendar (if used) | USA | Appointment events |
| Railway | Application hosting | EU West (Amsterdam) | Runs the application |

> **Action:** confirm each region and ensure the **paid** AI tier is used before
> any real patient data flows (a free AI tier that trains on prompts would breach
> clauses 3 and 5).

---

**Signed:**

For the Clinic: ______________________  Name: __________  Date: ________

For Remi: ______________________  Name: __________  Date: ________
