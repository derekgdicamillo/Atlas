# Cryptographic Identity and Provable Attribution for AI Agents

**The conceptual problem space behind Buzz's signed-message model**

Research date: 2026-07-30
Scope: conceptual layer, not product evaluation

---

## 0. Framing: what Buzz is actually asserting

Block released Buzz on 2026-07-21 as an open-source (Apache-2.0) self-hostable workspace on Nostr — chat, Git hosting, and AI agents under one signed identity. The technical claim worth extracting is narrow and specific, and it is the claim this report evaluates against the field:

From Block's engineering post:

> "Authorization does not erase authorship. The agent remains the author. Its credential proves who authorized it and under what conditions."

Concretely:

- An identity is a secp256k1 keypair. There are no accounts, only keys.
- Every action — message, reaction, commit, CI result, review comment, workflow step, merge approval — is a Nostr event: `{id (sha256 of canonical content), pubkey, kind, tags, sig (Schnorr)}`.
- An agent holds **its own** keypair and signs its own work.
- The human owner separately signs a **narrowly scoped authorization** for that agent. Two signatures, not one: authorship (agent) and authority (owner).
- Revocation is decomposed: revoking a leaked agent key does not require replacing the human identity, and removing an owner blocks reconnection **without erasing signing history**.
- The platform holds zero keys.

That last property — separating *authorship* from *authority* and making both independently revocable while history stays intact — is the interesting design move. Hold it; §6 shows it addresses roughly two of the five structural gaps the literature identifies, and side-steps rather than solves the others.

Block states the formal security model and specs are published separately on GitHub. I did not verify the spec repo contents, and Block's blog post does not name specific NIPs or event kinds. **Treat the mechanism description above as vendor-stated, not independently verified.**

---

## 1. Why agent identity became a hard problem in 2026

Four forces converged. None is new alone; the combination is.

### 1.1 Agents became principals, not sessions

The old model: an agent is a script running inside a human's session, using the human's token. That model breaks the moment agents act asynchronously, across organizational boundaries, without a human in the loop for each action.

Otsuka, Toyoda and Leung (arXiv:2604.23280, 2026-04-25) frame the core definitional problem: **AI Identity is "the continuous relationship between what an AI agent is declared to be and what it is observed to do."** Their point is that human and agent identity differ across four axes — substrate, persistence, verifiability, and legal standing — and identity systems built for humans fail on all four.

The industry converged fast on the architectural answer: agents are first-class non-human identities, cryptographically attested, short-lived at runtime, with the human preserved as a delegating subject via token exchange. Microsoft, AWS and Google all shipped versions of this within two quarters (§3.4).

### 1.2 Scale broke governance

The numbers, mostly from Cloud Security Alliance and Verizon 2026 research:

| Metric | Value | Source |
|---|---|---|
| NHI-to-human ratio, enterprise average | 45:1 | CSA, May 2026 |
| NHI-to-human ratio, cloud-native | 144:1 | CSA, May 2026 |
| Orgs whose legacy IAM cannot manage AI/NHI risk | 92% | CSA |
| Orgs with no clear ownership of agent identities | ~50% | CSA |
| **Orgs that can trace an agent action back to a human sponsor across all environments** | **28%** | CSA survey |
| Orgs not tracking AI identity creation at all | 16%+ | CSA token-sprawl analysis |
| Employees using unapproved AI tools | 45% (up from 15% YoY) | Verizon DBIR 2026 |
| Orgs reporting breaches involving NHIs | ~50% | industry aggregate |
| "Identity dark matter" vs. visible IAM assets | 57% / 43% | NHI Mgmt Group |

The 28% figure is the one that matters for this report. **Provable attribution of an agent action to a responsible human is, empirically, a minority capability in mid-2026.** That is the gap Buzz's two-signature model targets directly.

A related data point on the deployment reality: security researchers who scanned roughly 2,000 public MCP servers in early 2026 found essentially none enforcing authentication, despite the spec existing. The spec–deployment gap is large.

### 1.3 Agent-to-agent commerce made attribution financially load-bearing

Once agents transact, "who authorized this" stops being an audit nicety and becomes a chargeback dispute. The 2026 payment protocol landscape:

- **AP2 (Agent Payments Protocol)** — Google, 60+ partners. Defines the *trust and authorization* layer via cryptographically signed **mandates**. Notably uses **W3C Verifiable Credentials** to make user consent cryptographically auditable. Has an x402 extension for crypto rails.
- **x402** — Coinbase. Revives HTTP 402 for stablecoin machine-to-machine payments. V2 (Dec 2025) added **wallet-based identity** and CAIP-based multi-chain discovery (May 2026). Stripe integrated it on Base in Feb 2026; Cloudflare supports it. The x402 Foundation launched under the Linux Foundation in July 2026 with Coinbase's contribution complete.
- **ACP** (OpenAI/Stripe checkout), **MPP**, **UCP** — adjacent, more commerce-specific.

These are complementary, not competing: AP2 for authorization, ACP for checkout, x402/MPP for settlement. The identity substrate is where they diverge — AP2 chose W3C VCs, x402 chose wallet keypairs. **That is precisely the Buzz-style keypair vs. DID/VC fork, replayed in the payments layer.**

Security is not settled. *Free-Riding the Agentic Web: A Systematic Security Analysis of x402 Payments* (arXiv:2605.30998) is a systematic attack analysis of x402. *TessPay: Verify-then-Pay Infrastructure for Trusted Agentic Commerce* (arXiv:2602.00213) argues the verify-before-settle ordering is wrong in current designs.

### 1.4 Regulation put a date on it

EU AI Act **Article 12** (automatic logging, tamper-evident, ≥6-month retention) becomes enforceable for high-risk systems on **2026-08-02** — three days after this report's date. **Article 50** (machine-readable marking of AI-generated content) lands in the same window. Penalties reach €30M or 6% of global turnover. Details in §5.

---

## 2. The competing approaches — a taxonomy

Five families. They are not mutually exclusive; production systems are already stacking them.

### 2.1 Raw keypairs / self-certifying identity (the Nostr / Buzz family)

**Model:** the public key *is* the identity. No registry, no issuer, no resolution step. Signatures are self-verifying against the pubkey.

**Strengths:**
- Zero infrastructure. No ledger, no resolver, no trust registry to bootstrap.
- No intermediary can revoke or alter the identity — which is Block's explicitly stated objective.
- Verification is O(1) and offline.
- Naturally produces a tamper-evident, unified, searchable log because *every* action is an event of the same shape.
- Portability is free: the same key signs across chat, Git, CI, and workflow.

**Weaknesses — and these are well-documented and serious:**
- **No key rotation.** In vanilla Nostr your pubkey is your identity; you cannot rotate while keeping the identity. This is the single most-cited structural criticism of Nostr.
- **No recovery.** No password reset, no support desk, no backdoor. Lose the key, lose the identity, rebuild the social graph manually.
- **Compromise is catastrophic and hard to signal.** The entire protocol's guarantee is "this event came from this key." Once the key is stolen, every guarantee inverts, and there is no canonical revocation broadcast. Social attestation of a new key does not scale to mass compromise and reintroduces centralization if you use a platform to verify.

Buzz's two-signature design is a **partial, targeted answer** to exactly this: by splitting agent key from owner key, a compromised agent key is a bounded blast radius that can be revoked without touching the durable human identity. That is a real improvement over single-key Nostr. It does not fix human key loss or human key compromise.

Worth noting: `did:nostr` exists (TBD54566975/did-nostr; Nostr CG spec) precisely to bolt DID-style key rotation onto Nostr keypairs — binding multiple verification methods to one identity. The two families are not as opposed as the discourse suggests.

### 2.2 DIDs + Verifiable Credentials (the W3C family)

**Model:** a ledger-anchored or method-specific **DID** whose DID Document carries verification methods (rotatable, multiple, per-device). Third parties issue **VCs** asserting claims about the agent — identity attributes, fine-grained authorizations, arbitrary assertions. Trust is established by exchanging DID-bound credentials at interaction start.

**Key work:**

- **Rodriguez Garzon, Vaziry, Kuzu, Gehrmann, Varkan, Gaballa, Küpper — "AI Agents with Decentralized Identifiers and Verifiable Credentials"** (arXiv:2511.02841, submitted 2025-10-01, rev. 2025-12-15; accepted ICAART 2026). Proposes per-agent ledger-anchored DIDs plus third-party VCs to enable differentiated trust in peer-to-peer agent dialogue without centralized intermediaries. **Their headline negative finding matters:** the evaluation "reveals limitations once an agent's LLM is in sole charge to control the respective security procedures." Translation — when you let the LLM itself drive credential handling and crypto operations, it fails. Security procedures need to sit outside the model.
- **W3C Agent Identity Registry Protocol Community Group** — proposed 2026-04-22 by Aaron Adolfo Grego, launched **2026-04-24**, chaired by Adolfo Grego Micha, 41 participants. Scope: a DID method for agent identity resolution, an agent credential format on W3C VCs, a **trust negotiation protocol** for cross-org agent interaction, trust level definitions, integration profiles with MCP/A2A/OAuth-OIDC/SPIFFE, **revocation and credential lifecycle**, and **post-quantum requirements**. Coordinating with W3C Credentials CG, DIF, OpenID Foundation AIIM CG, and IETF WIMSE. Community Group status — **not a standards track, no Recommendation**.
- **KYA-OS (formerly MCP-I)** — Vouched donated the MCP-I framework to the **Decentralized Identity Foundation in March 2026**; renamed **Know Your Agent Operating System** to reflect scope beyond MCP. Spec v1.0.0 published; reference implementation at `decentralized-identity/kya-os-mcp`; governed by the KYA-OS Task Force inside DIF's Trusted AI Agents Working Group. DIF and Vouched announced further KYA-OS advancement in July 2026. Its framing is the cleanest articulation of the requirement I found: at any agent action you can verify **who called** (agent identity), **under what authority** (delegation chain rooted at a Responsible Party, plus consent where required), and **what they did** (signed proofs composing into audit trails).
- **TRAIL (`did:trail`)** — a draft DID method purpose-built for AI agents, with distinct identifier types for organizations, agents, and self-signed identities. W3C registry submission pending.

**Strengths:** key rotation, revocation lifecycle, third-party attestation (an agent can carry a credential asserting "licensed to act on medical records" issued by someone whose judgment you trust), post-quantum migration path, and an existing standards body.

**Weaknesses:** heavy. Requires resolvers, ledgers or equivalent anchoring, issuers, trust registries, and status lists. Bootstrapping the trust graph is the actual hard part, and none of these specs is a W3C Recommendation for agents yet.

### 2.3 OAuth-style delegated auth (the enterprise IAM family)

The pragmatic incumbent, and the one with real production traction.

- **MCP authorization** mandates **OAuth 2.1 with PKCE** for protected HTTP deployments, HTTPS everywhere, discoverable AS metadata.
- **ID-JAG (Identity JWT Authorization Grant)** — adopted by the IETF OAuth WG September 2025, incorporated into MCP November 2025.
- **Enterprise-Managed Authorization (EMA)** — reached spec-stable **2026-06-18**. Replaces per-user OAuth consent screens with an IdP-mediated zero-touch delegation model. Okta first supported IdP; adopted by Anthropic, Microsoft, Okta.
- **MCP 2026-07-28 release** — stateless core; authorization now aligns with production OAuth 2.0/OIDC so servers connect to Entra or Okta without workarounds.
- **Governance:** Anthropic donated MCP to the **Agentic AI Foundation (AAIF)** under the Linux Foundation by December 2025, with OpenAI, Block, AWS, Google, Microsoft, Cloudflare and Bloomberg as founding/platinum members. (Note: Block is a founding member of AAIF *and* the publisher of Buzz — they are hedging across both approaches.)
- **OpenID Foundation:** the AI Identity Management Community Group (AIIMCG) published *"Identity Management for Agentic AI"* (October 2025), naming **OpenID Federation** as a candidate trust fabric for agent-to-agent identity. In 2026 the **AuthZEN WG** approved the **Access Request and Approval Profile (AARP)** and the **AuthZEN Profile for MCP Tool Authorization (COAZ)** as official WG drafts. **OIDC-A ("OpenID Connect for Agents 1.0")** appears in secondary literature attributed to Benameur et al. — extending OIDC with agent identity, delegation chain validation, attestation verification, and capability-based authorization. **I could not confirm OIDC-A as a formally adopted OIDF specification; treat it as a proposal.**

**The structural weakness is well-identified:** OAuth 2.0 gives you clean **one-hop** delegation. Agent systems are multi-hop by nature. Chaining OAuth token exchanges across A→B→C loses the original principal's intent and scope. This is the "recursive delegation gap" (§6.2).

### 2.4 Workload identity / attestation (the SPIFFE family)

**SPIFFE/SPIRE** gives ephemeral, attestation-bound workload credentials — the identity is derived from *what is running where*, not from a long-lived secret.

- **IETF WIMSE** (Workload Identity in Multi-System Environments) — active WG. `draft-ietf-wimse-workload-creds-02`.
- **`draft-ni-wimse-ai-agent-identity-02`**, "WIMSE Applicability for AI Agents," Ni Yuan and Peter Chunchi Liu (Huawei), updated 2026-02-28, expires 2026-09-01. **Individual submission, not IETF-endorsed.** Argues agents need identities distinct from devices and users, and proposes **dual-identity credentials that cryptographically bind agent identity and owner identity together** — conceptually the same move as Buzz's two signatures, expressed in IETF terms. Three issuance models: agent-mediated (owner pre-signs locally), owner-mediated (owner as gateway), server-mediated (challenge-response). Emphasizes short-lived, task-scoped tokens.
- **`draft-klrc-aiagent-auth-02`** — AI Agent Authentication and Authorization.
- **AIMS (Agent Identity Management System)** — published 2026-03-02 by engineers from AWS, Zscaler, Ping Identity, and Defakto Security. A conceptual model for establishing, maintaining and evaluating agent workload identity and permissions. Deliberately invents nothing: maps SPIFFE (workload identity), WIMSE (workload-to-workload auth), OAuth 2.0 (authorization) and SSF onto a **9-layer agent stack**.

**Strength:** solves key custody almost entirely — credentials are short-lived and machine-attested, so there is no long-lived secret to steal. **Weakness:** binds to *execution context*, not to *authorship or intent*. It tells you a legitimate workload ran; it does not tell you the agent meant what it did, or who is responsible.

### 2.5 Content/output provenance (the C2PA family)

Orthogonal but adjacent — provenance of *artifacts* rather than *actors*.

- **C2PA / Content Credentials**, spec family at **2.4**. The **Conformance Program** soft-launched June 2025 and is fully operational in 2026, with two security levels and a path to hardware-backed assurance. Google's Pixel 10 was first to achieve the highest conformance level for secure capture and signing. The Interim Trust List was frozen 2026-01-01.
- OpenAI embeds C2PA in generated media and announced a May 2026 layered approach combining SynthID and public verification. Microsoft began adding C2PA metadata to M365 content February 2026.
- Regulatory hooks: **EU AI Act Article 50** and **California SB 942** both require machine-readable disclosure of AI-generated content. China's CAC Measures for Labeling AI-Generated Content (September 2025) mandate metadata attribution.

Relevant to Buzz because it is the one place where cryptographic provenance already has a working conformance and trust-list regime — the operational plumbing agent identity still lacks.

### 2.6 Capability-token / object-capability approaches

A quieter but conceptually important family. **UCAN**, **Biscuit**, and **Macaroons** attach attenuable authority to the token itself rather than resolving it against a registry — each delegation hop can only *narrow* scope, never widen it.

**Invocation-Bound Capability Tokens (IBCTs)** — Prakash, 2026 — fuse identity, attenuated authorization, and provenance binding into an **append-only token chain**: compact JWT for single-hop, Biscuit tokens with Datalog policies for multi-hop. This is arguably the most direct technical answer to the recursive-delegation gap, because monotonic attenuation is enforced by construction rather than by audit.

---

## 3. Academic and standards literature, 2025–2026

Grouped by what they actually contribute.

### 3.1 Surveys and gap analyses

**Otsuka, Toyoda, Leung — "AI Identity: Standards, Gaps, and Research Directions for AI Agents"** (arXiv:2604.23280, 2026-04-25). The single most useful reference in this space. Surveys SPIFFE/SPIRE, WIMSE, IETF AIMS, OAuth 2.0/2.1, SAML (judged architecturally incompatible with non-human principals), MCP, Google A2A, OIDF on-behalf-of flows, CIBA, W3C DID/VC, MCP-I, `did:trail`, C2PA, SLSA/Sigstore, DPoP (RFC 9449), CAEP, MAPL, and Agent Behavioral Contracts. Also maps vendor solutions and regulators (NIST NCCoE's five focus areas Feb 2026; CAISI AI Agent Standards Initiative; NHIMG). Identifies **five structural gaps** — reproduced in §6 — and concludes bluntly: *"These gaps are structural; more engineering effort alone will not close them."* **Does not cover healthcare.**

**Wang et al. — "From Agent Traces to Trust: Evidence Tracing and Execution Provenance in LLM Agents"** (arXiv:2606.04990, 2026-06-03). Treats provenance as *the accountability layer*. Proposes capturing retrieved documents, tool outputs, memory items, environment observations and inter-agent messages, linked by typed relations (**Support, Derive, Contradict, Invalidate, Trigger, Update**) into structured provenance graphs. Six unsolved problems: claim-level granularity (document-level citation masks whether a specific claim is actually supported); semantic vs. operational fragmentation; **post-hoc analysis rather than runtime enforcement**; memory contamination and poisoned memory; multi-agent failure localization; and incompatible trace schemas. Key observations: tool misuse usually comes from **untrusted parameter values**, not tool permissions; indirect prompt injection exploits **information flow**, not prompts; long-term memory creates **delayed causation** that is hard to trace backward.

### 3.2 Responsibility and liability

**Hu, Huang, He, Sun, Dong, Huang — "Responsible Agentic AI Requires Explicit Provenance"** (arXiv:2605.17169, 2026-05-16). The strongest normative argument in the set. Position: *"responsibility, despite being widely discussed, remains a subjective and unenforced concept."* Structures the problem as Why (responsibility gaps in sociotechnical systems), What (a **causal attribution function** and a **"responsibility tensor"**), How (provenance computable across four lifecycle layers with online interventions), Who (allocation via real agentic incidents). Core claim: **no current agentic framework produces the quantifiable, traceable, interventionable provenance needed to assign responsibility.** The absence is structural, not a benchmarking shortfall.

**"Acting with AI: An Interaction-Based Framework for Agentic Tort Liability"** (arXiv:2606.00518) — tort-law framework for agent liability.

**"Decentralized Governance of Autonomous AI Agents"** (arXiv:2412.17114) — earlier (Dec 2024) but foundational for the governance framing.

**"From Logic Monopoly to Social Contract: Separation of Power and the Institutional Foundations for Autonomous Agent Economies"** (arXiv:2603.25100) — institutional-design lens on agent economies.

### 3.3 Protocols and architectures

**Prakash — "AIP: Agent Identity Protocol for Verifiable Delegation Across MCP and A2A"** (arXiv:2603.24775, 2026-03-27). DIDs as identity anchors, VCs as signed capability attestations, JWT credentials, **RFC 8785 canonical JSON** for deterministic signing. Enables recursive delegation with verifiable audit trails and aims to prevent capability escalation. Situates itself against UCAN, Biscuit, Macaroons, and IETF AIMS/WIMSE.

**"Authorization Propagation in Multi-Agent AI Systems: Identity Governance as Infrastructure"** (arXiv:2605.05440).

**"Interoperable Architecture for Digital Identity Delegation for AI Agents with Blockchain Integration"** (arXiv:2601.14982).

**"Governable Individuals: An Identity Layer for Embodied Agents That Keep Learning"** (arXiv:2607.05463) — extends the problem to agents whose behavior changes post-deployment, which breaks any identity model that assumes a fixed artifact.

**"A Faceted Proposal for Transparent Attribution of AI-Assisted Text Production"** (arXiv:2604.25346) — granular human/AI contribution attribution rather than binary AI-generated labeling.

**CoSAI — "Agentic Identity and Access Management"** (Coalition for Secure AI, published ~March–April 2026). Widely cited as establishing the architectural principles the industry will converge on over the next 12–18 months. *I could not extract the PDF text; characterization here is from secondary sources.*

### 3.4 Vendor / platform positions

| Vendor | System | Status | Model |
|---|---|---|---|
| Microsoft | **Entra Agent ID** | GA April 2026 | Agent identity = specialized service principal with **no credentials of its own**; acquires short-lived tokens via a "blueprint." Enforced human sponsorship, lifecycle governance. Extends Conditional Access, Identity Protection, PIM to NHIs. Critique: strongest governance, works only inside Microsoft. |
| AWS | **Bedrock AgentCore Identity** | GA (before Entra) | Authentication and authorization, production SLA. Critique: no blueprint equivalent, no lifecycle management, no behavioral anomaly detection. |
| Google | **A2A** + **AP2** | Production | A2A converging on OAuth 2.0/OIDC with JWS signing; AP2 uses W3C VCs for auditable consent. |
| Anthropic | **MCP** auth stack | EMA stable 2026-06-18; MCP 2026-07-28 release | OAuth 2.1 + PKCE, ID-JAG, enterprise-managed IdP delegation. Donated MCP to AAIF/Linux Foundation Dec 2025. |
| Block | **Buzz** | Released 2026-07-21 | Nostr keypairs, two-signature authorship/authority split, zero platform-held keys. |
| Microsoft Security | least-privilege guidance | July 2026 | Identity, access, and **tool binding** as the least-privilege unit. |

The pattern: **hyperscalers converged on short-lived, IdP-brokered, non-portable agent identity. Block went the opposite direction — long-lived, self-sovereign, portable, no broker.** Both are coherent; they optimize for different failure modes. Hyperscalers optimize against key theft; Buzz optimizes against platform capture and audit-log tampering.

---

## 4. Regulatory and compliance drivers

### 4.1 EU AI Act — the hard deadline

**Article 12 (record-keeping and automatic logging)** becomes enforceable for high-risk AI systems on **2026-08-02**. Requirements:

- Automatic logging of events relevant to risk identification and traceability, throughout system lifetime.
- Logs must be **tamper-evident**.
- Retention ≥ **6 months**; 24 months for biometric and law enforcement systems.
- Article 18 extends technical documentation and conformity records to a **10-year** horizon.
- National Competent Authorities hold direct audit powers.
- Article 99 penalties: up to **€30M or 6% of global annual turnover** per violation.

Articles 12 and 13 together are read in the compliance literature as requiring **decision-level traceability** — not just "the system logged something" but documentation of how a specific decision was made. That is exactly the provenance-graph requirement from arXiv:2606.04990, expressed as law.

**Article 50** (machine-readable marking of AI-generated content) is the C2PA hook.

**Critical gap the survey literature flags:** *"The EU AI Act classifies risk but does not assign responsibility when a delegated agent acts outside its mandate."* Logging obligations without a liability allocation rule.

### 4.2 United States — fragmented, no federal identity mandate

- **No federal AI identity legislation.** NIST NCCoE published a concept paper identifying five focus areas (Feb 2026). CAISI runs an AI Agent Standards Initiative. OMB M-25-21 requires pre-deployment testing for federal biometric AI — no private-sector mandate.
- **California SB 942** — machine-readable AI content disclosure.

### 4.3 Healthcare — where attribution is already legally load-bearing

This is the most directly relevant regulatory layer for a clinical deployment, and it is worth being precise, because the requirements are narrower than the marketing suggests.

**HIPAA.** Applies to any system that accesses, uses, or discloses PHI — agents included. Obligations: minimum-necessary access controls, **audit-trail logging of every PHI access event**, and BAAs with every AI vendor touching PHI. The operative compliance guidance in 2026: audit trails need **decision-level evidence — which agent, which data, what action, what authorization.** Session logs alone do not satisfy regulators.

That four-tuple is almost exactly the KYA-OS formulation (who called / under what authority / what they did) and almost exactly what a two-signature Nostr event carries. **This is the strongest real-world fit for the Buzz model that I found.**

**ONC/ASTP HTI-1.** Final rule December 2023, effective January 2024. Established certification criterion **§170.315(b)(11)** for predictive Decision Support Interventions: **13 source attributes** for evidence-based DSIs and **31** for predictive DSIs (intended use, target population, training data, validation, known risks, limitations). First federal transparency requirement for AI embedded in certified health IT.

**HTI-5 — active regulatory uncertainty.** On **2025-12-29**, ASTP/ONC issued the HTI-5 proposed rule, which would **eliminate** both the source-attribute disclosure requirement and the predictive-DSI risk-management requirement. Comment closed **2026-02-27**; **no final rule as of April 2026.** So the federal healthcare AI transparency floor may be about to *drop*, not rise. Anyone building attribution infrastructure on an HTI-1 compliance thesis should track this.

**California AB 3030** (effective 2025-01-01). Health facilities, clinics, physician offices and group practices must attach a disclaimer to GenAI-generated communications about patient clinical information, plus instructions for reaching a human provider. **The exemption is the interesting part: communications read and reviewed by a licensed human provider are exempt.** So the law creates a direct legal incentive to have a provable record of human review. Enforcement runs through the Medical Board of California / Osteopathic Medical Board — disciplinary, not a private right of action, and it does not set a malpractice standard.

**Prior-authorization restrictions.** Alabama, Indiana, Utah and Washington now prohibit sole reliance on AI for adverse determinations and require independent professional judgment. Again: a legal requirement that a human decision exists and is distinguishable from the machine's.

**Liability.** 2026 healthcare AI laws do not assign blame to algorithms. They strengthen existing medical liability standards by **requiring active supervision**. Responsibility is shared across clinician, vendor, and organization. Legal precedent with AI as the central element remains thin; courts have not settled how AI performance data will be weighed. Relevant paper: *"The Clinician's Veto: Navigating Trust, Liability, and Uncertainty in Autonomous AI Prescribing"* (arXiv:2606.25108). Also *MedBeads: An Agent-Native, Immutable Data Substrate for Trustworthy Medical AI* (arXiv:2602.01086), which is the closest healthcare-specific analogue to the Buzz substrate thesis.

**The healthcare synthesis:** every one of these rules turns on a boundary — *did a human review this, decide this, authorize this, or not?* Current systems answer that boundary question with database flags and session logs, which are trivially mutable by whoever runs the database. A signed, tamper-evident, two-party attribution record is a materially better evidentiary artifact for exactly that question. **That is the honest case for the Buzz model in a clinical setting**, and it is narrower and more defensible than "cryptographic identity for agents."

### 4.4 Other jurisdictions

- **China** — CAC Measures for Labeling AI-Generated Content (Sept 2025) mandate metadata attribution. Draft virtual-human rules prohibit synthetic personas bypassing biometric authentication.
- **Singapore** — IMDA Model Governance Framework (Jan 2026): accountability, transparency, oversight, data governance. CSA Addendum designates **identity spoofing as threat T9**, requires verifiable credentials, and prohibits cross-agent privilege delegation without explicit authorization.
- **Japan** — AI Promotion Act (May 2025), principles-based, non-binding; METI/MIC guidelines voluntary.
- **EU adjacent** — eIDAS 2.0 / EUDI Wallet infrastructure; Cyber Resilience Act (Dec 2024).

**Fragmentation is itself a finding:** an agent compliant in one jurisdiction may violate requirements in another, and **no jurisdiction has established a liability framework for autonomous AI agents.**

---

## 5. What is actually unsolved

Synthesizing across arXiv:2604.23280 (five structural gaps), arXiv:2606.04990 (six tracing gaps), arXiv:2605.17169 (provenance), and the industry literature. I have marked where the Buzz-style signed-message model helps, partially helps, or does not apply.

### 5.1 The semantic intent gap — **unsolved, and signatures do not touch it**

The false assumption the field has been running on: *cryptographic correctness implies semantic correctness.* A TEE proves code ran unmodified. A signature proves a key authorized a payload. **Neither proves the reasoning behind the decision was genuine rather than hijacked.**

A prompt-injected agent signs its malicious action with a perfectly valid key. The signature is correct. The audit trail is clean. The action is compromised. Buzz's model makes this *attributable* — you will know exactly which agent did it and who authorized that agent — but it does not make it *preventable* or even *detectable at signing time*.

This is the deepest gap. Proposed directions: extending SVIP (secret-based verifiable LLM inference) to behavioral intent, Agent Behavioral Contracts encoding intent claims, human-in-the-loop attestation at semantically critical decision points. None is production-ready.

### 5.2 Recursive delegation and accountability — **partially addressed**

A delegates to B delegates to C. Who is responsible? Only **24.4%** of organizations report full visibility into agent-to-agent communication across three or more hops. Once Agent A is credentialed, KYA-style frameworks provide no mechanism to constrain what B does when A delegates onward. Multi-principal modeling is explicitly called unsolved.

Buzz's two-signature chain is a genuine partial answer for **one hop** — authorship and authority are separately provable. Whether it composes across N hops with monotonic scope attenuation is the open question, and Block's public post does not address it. The technically strongest answers here are capability-based: **IBCTs, UCAN, Biscuit** — where attenuation is enforced by token construction rather than discovered by audit.

Needed: scope-attenuation protocols enforcing monotonic privilege reduction, bidirectional signing tying each agent to both upstream principals and downstream delegates, cross-organizational immutable audit trails.

### 5.3 Agent identity integrity — **unsolved**

Three live attack surfaces:

1. **Prompt-injection hijack** — credentials remain valid after control transfer.
2. **Credential sharing / instance cloning** — one identity running across hundreds of concurrent instances, indistinguishably.
3. **Impersonation within delegation chains.**

**No production mechanism binds an identity to a specific running instance.** Buzz does not solve this; a copied agent private key produces indistinguishable valid signatures. SPIFFE-style attestation is the better answer here, and it is the clearest argument for stacking attestation *under* signature rather than choosing between them.

Directions: instance-binding schemes tying credentials to specific enclaves, behavioral anomaly detection folded into credential validation, lightweight Sybil resistance.

### 5.4 Key custody, rotation and revocation — **partially addressed, still the sharpest practical edge**

Revocation needs at least three layers, including **key revocation that rotates keys without losing the DID**. Nostr's base model cannot do this. Buzz's decomposition (revoke agent key without touching human identity; remove owner without erasing history) is a real, well-designed improvement — but it inherits the human-key problem underneath.

The counter-position from the enterprise camp is strong and worth stating plainly: agents that inherit a human session or API key make every action **unrevocable without locking the human out**. Short-lived, per-run workload credentials fix that structurally by having nothing durable to steal. The tradeoff: short-lived credentials also mean **no durable authorship record** — the thing Buzz is optimizing for. These two goals are in genuine tension and nobody has cleanly resolved it.

Operational recommendation from the practitioner literature: build and *test* revocation and recovery paths — practice disabling the agent identity, rotating credentials, and executing rollback or compensating actions.

### 5.5 Runtime enforcement vs. post-hoc audit — **unsolved**

Most provenance work is **post-hoc analysis, not runtime prevention** (arXiv:2606.04990). A tamper-evident log tells you what happened after it happened. For an agent that just sent a message to a patient, "provably attributable" and "prevented" are very different products. Buzz is squarely in the post-hoc camp — which is the right camp for compliance evidence and the wrong camp for safety.

### 5.6 Memory contamination and delayed causation — **unsolved, and underrated**

Stale, conflicting or poisoned memory propagates through agent decisions. Long-term memory introduces **delayed causation** — an action today traceable to a memory written weeks ago under different conditions. Signed events give you the write record; they do not give you the causal graph from write to eventual decision. Claim-level granularity is unsolved: document-level citations mask whether a specific claim is actually supported.

### 5.7 Governance opacity and the shadow-agent problem — **unsolved, and partly self-inflicted**

82% of organizations report confidence in agent governance while actively monitoring **47.1%** of deployed agents. The perverse dynamic: **overly strict identity requirements push legitimate workflows into unsanctioned channels**, outside any audit framework. This is why the 45% unapproved-AI-tool figure matters — friction generates shadow agents faster than policy suppresses them.

Directions: tiered verification applying strong requirements only at high-risk decision points; aggregate behavioral monitoring; lightweight onboarding. Note that this cuts *for* the Buzz model — zero-infrastructure keypairs have far lower onboarding friction than a DID/VC trust-registry bootstrap.

### 5.8 Operational cost and sustainability — **not even measured**

*"The field has not established baseline measurements of verification overhead at operational agent scale."* Energy cost of ZKP generation, TEE attestation and immutable logging at planetary scale is framed as an engineering problem rather than an ecological constraint. Open: what ecological ceiling applies, which verification can be amortized or made probabilistic, whether the energy budget is compatible with sustainability commitments.

### 5.9 Legal standing and the liability vacuum — **unsolved by anyone, and not a technical problem**

No jurisdiction has a liability framework for autonomous AI agents. The EU AI Act classifies risk without assigning responsibility for out-of-mandate delegated action. Agents have no legal standing. Healthcare handles this by refusing the question — liability stays with the supervising human, which is why every 2026 healthcare AI rule is fundamentally a *supervision* requirement.

**Implication worth stating directly:** as long as liability attaches to the supervising human, the highest-value function of agent identity infrastructure is not proving what the *agent* did. It is **proving what the human authorized, and proving the human's review actually occurred.** Buzz's owner-signature is arguably the more valuable half of its two-signature model, and the marketing emphasis on agent authorship somewhat obscures that.

### 5.10 Portable trust across boundaries — **the consensus "actually hard part"**

The most-repeated framing in the 2026 industry literature: minting an agent identity is solved — every cloud can do it. **Portable trust across clouds, runtimes and protocols is not solved by anyone.** This is where a protocol-native, broker-free identity like Nostr has a genuine structural argument, and where Entra/AgentCore have a genuine structural weakness. It is also where the W3C Agent Identity Registry CG's "trust negotiation protocol" work is aimed, and that work is at Community Group maturity — meaning years, not quarters.

### 5.11 Post-quantum — **on the roadmap, unaddressed in deployed systems**

The W3C Agent Identity Registry CG lists post-quantum cryptographic requirements in scope. Nostr's secp256k1 Schnorr signatures are not post-quantum. Any identity model where **the key is permanently the identity** has a harder migration path than one where keys are rotatable references — which is a long-horizon structural argument for DIDs over raw keypairs.

---

## 6. Reading Buzz against the field

Where the model is genuinely well-positioned:

1. **Authorship/authority separation** is the right decomposition, and the IETF WIMSE AI-agent draft independently arrives at the same "dual-identity credential" primitive. Convergent design from two very different traditions is a good signal.
2. **Uniform event shape across chat, code, CI and workflow** produces the single unified tamper-evident audit log that EU AI Act Art. 12 and HIPAA audit-trail rules both effectively demand. Most competing stacks produce fragmented, per-system logs — and "incompatible trace schemas" is one of the six named gaps in arXiv:2606.04990.
3. **Zero platform-held keys** directly answers the audit-integrity question that logging-based approaches cannot: who could have edited the log?
4. **Low onboarding friction** cuts against the shadow-agent dynamic (§5.7).
5. **Portability** targets the one thing the industry agrees is unsolved (§5.10).

Where it is weak or silent:

1. **No key rotation or recovery** at the human layer. This is Nostr's oldest and best-documented criticism. `did:nostr` exists as a mitigation path; whether Buzz adopts it is unknown to me.
2. **No instance binding** — a copied agent key is undetectable (§5.3). Stacking SPIFFE-style attestation underneath would close this and is not obviously incompatible.
3. **Multi-hop attenuation unaddressed** in public materials (§5.2).
4. **Post-hoc, not preventive** (§5.5).
5. **Signatures are orthogonal to intent** (§5.1) — and the ICAART 2026 DID/VC paper's negative result is a warning that applies here too: **do not let the LLM drive its own signing procedures.** Whatever holds the agent key must sit outside the model's control surface.
6. **Not post-quantum** (§5.11).
7. **No trust registry / third-party attestation.** A raw keypair can prove *continuity* ("same actor as before") but not *attributes* ("this agent is authorized to touch PHI"). VCs can carry that; bare Nostr keys cannot without an added layer. In a regulated setting, attribute attestation is often the thing you actually need.

Note also that Block is simultaneously a founding/platinum member of the Linux Foundation's AAIF (the MCP/OAuth camp) and the publisher of Buzz (the keypair camp). The bet is hedged.

---

## 7. Bottom line

The problem Buzz addresses is real, urgent, and — by the field's own measurement — mostly unsolved: only **28% of organizations can trace an agent's action back to a human sponsor across all environments**, three days before EU AI Act Article 12 becomes enforceable.

The field has converged on the *requirement* — KYA-OS states it cleanly as **who called, under what authority, what they did** — and has not converged on the *mechanism*. Five families compete: raw keypairs, DIDs+VCs, OAuth delegation, workload attestation, and capability tokens. They are more complementary than the discourse suggests; the likely end state stacks attestation under signature under credential.

Buzz's contribution is a specific and defensible decomposition — separating authorship from authority, making each independently revocable, keeping history intact, and holding no platform keys. That solves the **evidentiary** problem well. It does not touch the **semantic** problem (a hijacked agent signs valid events), the **instance-binding** problem (copied keys are indistinguishable), or the **liability** problem (no jurisdiction has a framework).

For healthcare specifically, the sharpest fit is narrower than the general pitch: every 2026 clinical AI rule — AB 3030's human-review exemption, HIPAA's decision-level audit requirement, the four-state prior-auth restrictions, and the shared-liability supervision standard — turns on proving that **a specific human reviewed, decided, or authorized** a specific action. Database flags and session logs answer that question with evidence that whoever runs the database can rewrite. A signed, two-party, tamper-evident record answers it with evidence they cannot. That is a real and legally meaningful upgrade, and it is worth being precise that this is the claim rather than the broader one.

Watch: HTI-5's final rule (may *lower* the federal transparency floor), the W3C Agent Identity Registry CG's trust-negotiation output, whether capability-attenuation (IBCT/UCAN/Biscuit) merges into the signature-based camp, and whether any jurisdiction assigns liability for out-of-mandate delegated agent action.

---

## Sources

### Primary — papers

- Otsuka, Toyoda, Leung. *AI Identity: Standards, Gaps, and Research Directions for AI Agents.* arXiv:2604.23280 (2026-04-25). https://arxiv.org/abs/2604.23280 · https://arxiv.org/html/2604.23280v1
- Hu, Huang, He, Sun, Dong, Huang. *Responsible Agentic AI Requires Explicit Provenance.* arXiv:2605.17169 (2026-05-16). https://arxiv.org/abs/2605.17169
- Wang et al. *From Agent Traces to Trust: Evidence Tracing and Execution Provenance in LLM Agents.* arXiv:2606.04990 (2026-06-03). https://arxiv.org/html/2606.04990v1
- Rodriguez Garzon, Vaziry, Kuzu, Gehrmann, Varkan, Gaballa, Küpper. *AI Agents with Decentralized Identifiers and Verifiable Credentials.* arXiv:2511.02841 (2025-10-01, rev. 2025-12-15); ICAART 2026. https://arxiv.org/abs/2511.02841 · https://www.scitepress.org/Papers/2026/142344/142344.pdf
- Prakash. *AIP: Agent Identity Protocol for Verifiable Delegation Across MCP and A2A.* arXiv:2603.24775 (2026-03-27). https://arxiv.org/pdf/2603.24775
- *Authorization Propagation in Multi-Agent AI Systems: Identity Governance as Infrastructure.* arXiv:2605.05440. https://arxiv.org/html/2605.05440v1
- *Interoperable Architecture for Digital Identity Delegation for AI Agents with Blockchain Integration.* arXiv:2601.14982. https://arxiv.org/pdf/2601.14982
- *Governable Individuals: An Identity Layer for Embodied Agents That Keep Learning.* arXiv:2607.05463. https://arxiv.org/pdf/2607.05463
- *A Faceted Proposal for Transparent Attribution of AI-Assisted Text Production.* arXiv:2604.25346. https://arxiv.org/pdf/2604.25346
- *From Logic Monopoly to Social Contract: Separation of Power and the Institutional Foundations for Autonomous Agent Economies.* arXiv:2603.25100. https://arxiv.org/pdf/2603.25100
- *Free-Riding the Agentic Web: A Systematic Security Analysis of x402 Payments.* arXiv:2605.30998. https://arxiv.org/pdf/2605.30998
- *TessPay: Verify-then-Pay Infrastructure for Trusted Agentic Commerce.* arXiv:2602.00213. https://arxiv.org/pdf/2602.00213
- *Acting with AI: An Interaction-Based Framework for Agentic Tort Liability.* arXiv:2606.00518. https://arxiv.org/pdf/2606.00518
- *The Clinician's Veto: Navigating Trust, Liability, and Uncertainty in Autonomous AI Prescribing.* arXiv:2606.25108. https://arxiv.org/pdf/2606.25108
- *MedBeads: An Agent-Native, Immutable Data Substrate for Trustworthy Medical AI.* arXiv:2602.01086. https://arxiv.org/pdf/2602.01086
- *Decentralized Governance of Autonomous AI Agents.* arXiv:2412.17114. https://arxiv.org/pdf/2412.17114
- *A Survey on Decentralized Identifiers and Verifiable Credentials.* arXiv:2402.02455. https://arxiv.org/pdf/2402.02455

### Primary — standards and specifications

- W3C Agent Identity Registry Protocol Community Group. https://www.w3.org/community/agent-identity/
- IETF. *WIMSE Applicability for AI Agents* (draft-ni-wimse-ai-agent-identity-02). https://datatracker.ietf.org/doc/draft-ni-wimse-ai-agent-identity/
- IETF. *AI Agent Authentication and Authorization* (draft-klrc-aiagent-auth-02). https://datatracker.ietf.org/doc/draft-klrc-aiagent-auth/
- IETF. *WIMSE Workload Credentials* (draft-ietf-wimse-workload-creds-02). https://datatracker.ietf.org/doc/draft-ietf-wimse-workload-creds/
- DIF. *Why We Brought KYA-OS (formerly MCP-I) to DIF.* https://blog.identity.foundation/why-dif-said-yes-to-mcp-i/
- DIF. *DIF and Vouched Advance Agentic Identity with KYA-OS.* https://blog.identity.foundation/kya-os/
- DIF. KYA-OS MCP reference implementation. https://github.com/decentralized-identity/kya-os-mcp
- OpenID Foundation. *New whitepaper tackles AI agent identity challenges.* https://openid.net/new-whitepaper-tackles-ai-agent-identity-challenges/
- OpenID Foundation. AI Identity Management Community Group. https://openid.net/cg/artificial-intelligence-identity-management-community-group/
- OpenID Foundation. *AuthZEN advances for the agent era.* https://openid.net/openid-foundation-advances-authorization-for-the-agent-era-with-new-authzen-working-group-drafts/
- Model Context Protocol. *Enterprise-Managed Authorization.* https://blog.modelcontextprotocol.io/posts/enterprise-managed-auth/
- Anthropic. *MCP 2026-07-28 spec.* https://claude.com/blog/bringing-mcp-2026-07-28-to-claude
- C2PA Conformance Program. https://c2pa.org/conformance/ · https://contentauthenticity.org/blog/raising-the-bar-for-trust-introducing-the-c2pa-conformance-program
- Nostr DID Method Specification. https://nostrcg.github.io/did-nostr/ · https://github.com/TBD54566975/did-nostr
- CoSAI. *Agentic Identity and Access Management* (PDF; text not extracted). https://www.coalitionforsecureai.org/wp-content/uploads/2026/04/agentic-identity-and-access-control.pdf
- Microsoft Learn. Entra Agent ID. https://learn.microsoft.com/en-us/entra/agent-id/what-is-microsoft-entra-agent-id
- Google Cloud. *Announcing Agent Payments Protocol (AP2).* https://cloud.google.com/blog/products/ai-machine-learning/announcing-agents-to-payments-ap2-protocol

### Primary — Buzz

- Block Engineering. *Buzz!* https://engineering.block.xyz/blog/buzz

### Regulatory

- EU AI Act Article 12. https://www.aiacto.eu/en/obligations/art-12 · https://certifieddata.io/eu-ai-act/article-12-record-keeping
- *EU AI Act Articles 12 & 13: Decision Traceability & Audit Compliance (2026).* https://aigovernancedesk.com/eu-ai-act-articles-12-13-decision-traceability/
- California AB 3030 (full text). https://leginfo.legislature.ca.gov/faces/billTextClient.xhtml?bill_id=202320240AB3030
- ArentFox Schiff. *California Requires Disclaimers for AI-Generated Patient Communications.* https://www.afslaw.com/perspectives/alerts/california-requires-disclaimers-health-care-providers-ai-generated-patient
- Duane Morris. *California Passes Novel Law Governing Generative AI in Healthcare.* https://www.duanemorris.com/alerts/california_passes_novel_law_governing_generative_ai_healthcare_1224.html
- NCBI Bookshelf. *Liability for use of artificial intelligence in medicine.* https://www.ncbi.nlm.nih.gov/books/NBK613216/

### Secondary — industry analysis and statistics

- CSA. *The Non-Human Identity Governance Vacuum.* https://labs.cloudsecurityalliance.org/research/csa-whitepaper-nonhuman-identity-agentic-ai-governance-v1-cs/
- Token Security. *2026 DBIR: Identity Is the Control Plane for Agentic AI.* https://www.token.security/blog/the-2026-data-breach-investigations-report-confirms-it-identity-is-the-control-plane-for-agentic-ai
- Security Boulevard. *The Agent Identity Problem: NHIs Outnumber Humans 45 to 1.* https://securityboulevard.com/2026/07/the-agent-identity-problem-non-human-identities-outnumber-humans-45-to-1-and-ai-agents-are-making-it-worse/
- Resilient Cyber. *Identity Is the Agentic AI Problem Nobody Has Solved Yet.* https://www.resilientcyber.io/p/identity-is-the-agentic-ai-problem
- Microsoft Security. *Least privilege for AI agents: identity, access, and tool binding.* https://www.microsoft.com/en-us/security/blog/2026/07/16/least-privilege-for-ai-agents-identity-access-and-tool-binding/
- Crossmint. *Agentic payments protocols compared (MPP, ACP, AP2, x402).* https://www.crossmint.com/learn/agentic-payments-protocols-compared
- Kiteworks. *AI Agents and HIPAA: Solving the PHI Access Challenge.* https://www.kiteworks.com/hipaa-compliance/ai-agents-hipaa-phi-access/
- Bitcoin Magazine. *Nostr Will Have To Solve Its Key Management Issues.* https://bitcoinmagazine.com/technical/solving-nostr-key-management-issues
- Nostr key management guide. https://nostr.co.uk/learn/key-management/
- Aethyr Research. *Entra Agent ID: best agent identity system that only works inside Microsoft.* https://aethyrresearch.com/blog/microsoft-entra-agent-id
- Content Authenticity Initiative. *The State of Content Authenticity in 2026.* https://contentauthenticity.org/blog/the-state-of-content-authenticity-in-2026

---

## Verification notes and confidence

**High confidence** (primary source fetched and read directly): arXiv:2604.23280 including the five gaps and full standards inventory; arXiv:2605.17169; arXiv:2606.04990; arXiv:2511.02841; arXiv:2603.24775; W3C Agent Identity Registry CG charter, formation date and participant count; IETF draft-ni-wimse-ai-agent-identity-02 authorship, dates and dual-identity proposal; Block's Buzz engineering post claims.

**Medium confidence** (multiple independent secondary sources, primary not fetched): EU AI Act Art. 12 retention and penalty figures; HTI-1 §170.315(b)(11) attribute counts; HTI-5 proposed-rule status; AB 3030 scope and exemption; MCP EMA and MCP 2026-07-28 dates; Entra Agent ID / AgentCore GA status; x402 and AP2 timeline; C2PA conformance status; CSA and Verizon DBIR statistics; KYA-OS donation and rename.

**Flagged as unverified:**
- **OIDC-A ("OpenID Connect for Agents 1.0")** — appears in secondary literature attributed to Benameur et al., but I could not confirm it as a formally adopted OpenID Foundation specification. Treat as proposal, not standard.
- **CoSAI Agentic IAM whitepaper** — PDF text extraction failed; all characterization is from secondary sources.
- **Buzz's Nostr event kinds / NIPs** — Block's post does not specify them and points to a separate GitHub spec I did not retrieve. The mechanism description in §0 is vendor-stated.
- **IBCT paper** (Prakash, 2026) — described in secondary summaries; I did not locate and read the primary.
- Several 2026 statistics (24.4% multi-hop visibility, 82%/47.1% governance-monitoring gap) come from the arXiv:2604.23280 survey's citations rather than from the underlying surveys directly.

**Known coverage gap:** arXiv:2604.23280, the field's best survey, explicitly does not address healthcare. Section 4.3 is therefore assembled from regulatory and legal sources rather than from the agent-identity research literature, and the two bodies of work have not, as far as I can tell, been connected by anyone. That connection is itself an opportunity.
