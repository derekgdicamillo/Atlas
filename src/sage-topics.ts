/**
 * S.A.G.E. Topic Registry
 *
 * Config-driven definitions for all 15 knowledge categories.
 * Adding a new topic = adding one object to TOPIC_REGISTRY.
 */

export interface TopicConfig {
  category: string;
  label: string;
  scope: 'state' | 'national';
  refreshCadenceDays: number;
  researchPromptTemplate: string;
  qualityCriteria: string[];
  intentKeywords: string[];
  hedgingExemptions?: string[];
}

// All 50 states
export const ALL_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","FL","GA",
  "HI","ID","IL","IN","IA","KS","KY","LA","ME","MD",
  "MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ",
  "NM","NY","NC","ND","OH","OK","OR","PA","RI","SC",
  "SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
];

export const STATE_NAMES: Record<string, string> = {
  AL:"Alabama",AK:"Alaska",AZ:"Arizona",AR:"Arkansas",
  CA:"California",CO:"Colorado",CT:"Connecticut",DE:"Delaware",
  FL:"Florida",GA:"Georgia",HI:"Hawaii",ID:"Idaho",
  IL:"Illinois",IN:"Indiana",IA:"Iowa",KS:"Kansas",
  KY:"Kentucky",LA:"Louisiana",ME:"Maine",MD:"Maryland",
  MA:"Massachusetts",MI:"Michigan",MN:"Minnesota",MS:"Mississippi",
  MO:"Missouri",MT:"Montana",NE:"Nebraska",NV:"Nevada",
  NH:"New Hampshire",NJ:"New Jersey",NM:"New Mexico",NY:"New York",
  NC:"North Carolina",ND:"North Dakota",OH:"Ohio",OK:"Oklahoma",
  OR:"Oregon",PA:"Pennsylvania",RI:"Rhode Island",SC:"South Carolina",
  SD:"South Dakota",TN:"Tennessee",TX:"Texas",UT:"Utah",
  VT:"Vermont",VA:"Virginia",WA:"Washington",WV:"West Virginia",
  WI:"Wisconsin",WY:"Wyoming",
};

export const PRIORITY_STATES = ["TX", "CA", "FL", "NY", "AZ"];

function statePrompt(topic: string, details: string): string {
  return `You are researching medical aesthetics regulations and practice guidance for {{state_name}} ({{state_code}}).

Topic: ${topic}

${details}

## Output Format
Return ONLY valid JSON (no markdown fences):
{
  "state_code": "{{state_code}}",
  "chunks": [
    {
      "title": "Descriptive title",
      "content": "Detailed content (400-800 words). Include specific statute citations, board rule numbers, URLs, dollar figures, dates.",
      "source_name": "Source organization name",
      "source_url": "https://source.url"
    }
  ]
}

You may return multiple chunks if the topic has distinct sub-sections (e.g., one chunk per provider type). Each chunk should be self-contained.
Be factual. Include actual statute numbers, board URLs, and dates. If you cannot find specific information, note what is unknown.`;
}

function nationalPrompt(topic: string, details: string): string {
  return `You are researching current information for the S.A.G.E. Practice Advisor knowledge base, which serves aesthetic practitioners (NPs, RNs, PAs, estheticians) starting or running medical aesthetics practices.

Topic: ${topic}

${details}

## Output Format
Return ONLY valid JSON (no markdown fences):
{
  "chunks": [
    {
      "title": "Descriptive title",
      "content": "Detailed content (400-800 words). Include specific data, statistics, pricing, regulatory citations, URLs.",
      "source_name": "Source organization name",
      "source_url": "https://source.url"
    }
  ]
}

You may return multiple chunks if the topic has distinct sub-sections. Each chunk should be self-contained.
Use current data from 2025-2026. Cite specific numbers, studies, and organizations. No vague generalities.`;
}

export const TOPIC_REGISTRY: TopicConfig[] = [
  // ============================================================
  // STATE-SPECIFIC (6)
  // ============================================================
  {
    category: "scope_of_practice",
    label: "Scope of Practice",
    scope: "state",
    refreshCadenceDays: 30,
    researchPromptTemplate: statePrompt("NP/PA Scope of Practice in Medical Aesthetics", `Research:
- NP practice authority level in {{state_name}} (full/reduced/restricted)
- Collaborative or supervisory agreement requirements
- What aesthetic procedures NPs can perform independently vs. under supervision
- PA scope of practice for aesthetic procedures
- Board of nursing URL and relevant practice act citations
- APRN compact participation status
- Recent legislative changes affecting aesthetic practice scope`),
    qualityCriteria: ["statute_citation", "board_url", "practice_authority_level", "provider_type_distinction"],
    intentKeywords: ["scope", "practice authority", "can I perform", "NP allowed", "collaborative agreement", "independent practice", "APRN"],
    hedgingExemptions: ["varies by state", "check with your board", "consult a healthcare attorney", "subject to change"],
  },
  {
    category: "medspa_compliance",
    label: "MedSpa Compliance & CPOM",
    scope: "state",
    refreshCadenceDays: 30,
    researchPromptTemplate: statePrompt("MedSpa Compliance & Corporate Practice of Medicine", `Research:
- Can an NP/PA own a medspa in {{state_name}}?
- Corporate Practice of Medicine (CPOM) doctrine applicability
- Medical Director requirements (proximity, availability, compensation ranges)
- MSO/management company structure requirements and restrictions
- Key board rules and statute citations
- Recent enforcement actions or guidance changes
- Common compliance pitfalls in {{state_name}}`),
    qualityCriteria: ["statute_citation", "board_url", "cpom_applicability", "medical_director_requirements"],
    intentKeywords: ["CPOM", "medical director", "compliance", "own a medspa", "corporate practice", "MSO", "management company"],
    hedgingExemptions: ["varies by state", "check with your board", "consult a healthcare attorney"],
  },
  {
    category: "delegation_supervision",
    label: "Delegation & Supervision",
    scope: "state",
    refreshCadenceDays: 30,
    researchPromptTemplate: statePrompt("Delegation & Supervision Rules for Aesthetic Procedures", `Research:
- What can be delegated to RNs, LPNs, medical assistants, estheticians in {{state_name}}
- Supervision requirements by procedure type (on-site, available, general)
- Training/certification requirements for delegated procedures
- Specific rules for: injectables (neurotoxin, filler), lasers/IPL, chemical peels, microneedling
- Who can operate laser devices by class
- Documentation requirements for delegation
- Recent changes or board guidance`),
    qualityCriteria: ["statute_citation", "provider_type_distinction", "procedure_specificity", "supervision_level"],
    intentKeywords: ["delegate", "supervision", "who can", "RN perform", "esthetician", "medical assistant", "laser operator"],
    hedgingExemptions: ["varies by state", "check with your board"],
  },
  {
    category: "business_entity",
    label: "Business Entity & Formation",
    scope: "state",
    refreshCadenceDays: 45,
    researchPromptTemplate: statePrompt("MedSpa Business Entity Formation", `Research:
- Required entity type for medical practices in {{state_name}} (LLC, PLLC, PC, Corp)
- State registration and licensing requirements for medical practices
- Professional licensing requirements for business entities
- Tax considerations specific to {{state_name}} (franchise tax, state income tax)
- Business license and permit requirements
- Zoning considerations for medical aesthetic practices
- Annual filing and renewal requirements`),
    qualityCriteria: ["entity_types", "registration_url", "tax_info", "licensing_requirements"],
    intentKeywords: ["LLC", "PLLC", "entity", "incorporate", "business formation", "register", "business license", "EIN"],
  },
  {
    category: "marketing_compliance",
    label: "Marketing Compliance",
    scope: "state",
    refreshCadenceDays: 30,
    researchPromptTemplate: statePrompt("Medical Aesthetics Marketing Compliance", `Research:
- {{state_name}} rules on before/after photo advertising for medical procedures
- Testimonial and review solicitation restrictions
- Social media advertising rules for medical practices
- Required disclaimers for aesthetic procedure advertising
- Board of medicine advertising guidelines
- FTC compliance as applied in {{state_name}}
- Restrictions on pricing claims, guarantees, or "best" claims
- Rules on advertising specific brand names (Botox, Juvederm, etc.)
- Recent enforcement actions for marketing violations`),
    qualityCriteria: ["statute_citation", "board_url", "specific_restrictions", "disclaimer_requirements"],
    intentKeywords: ["advertising", "before after photo", "testimonial", "marketing rules", "social media compliance", "disclaimer", "can I advertise"],
    hedgingExemptions: ["varies by state", "consult a healthcare attorney"],
  },
  {
    category: "insurance_malpractice",
    label: "Insurance & Malpractice",
    scope: "state",
    refreshCadenceDays: 45,
    researchPromptTemplate: statePrompt("Insurance & Malpractice Coverage for MedSpas", `Research:
- Required malpractice insurance minimums in {{state_name}} for NPs/PAs
- General liability requirements for medical practices
- Professional liability (errors & omissions) requirements
- Workers' compensation requirements
- Tail coverage considerations
- Common exclusions in medspa policies
- Typical premium ranges for aesthetic practices in {{state_name}}
- Cyber liability and HIPAA breach coverage requirements
- Product liability considerations for injectables and devices`),
    qualityCriteria: ["coverage_minimums", "premium_ranges", "requirement_citations"],
    intentKeywords: ["insurance", "malpractice", "liability", "coverage", "premium", "tail coverage", "workers comp"],
  },

  // ============================================================
  // NATIONAL (9)
  // ============================================================
  {
    category: "osha_safety",
    label: "OSHA & Workplace Safety",
    scope: "national",
    refreshCadenceDays: 30,
    researchPromptTemplate: nationalPrompt("OSHA Compliance for Medical Aesthetic Practices", `Research:
- Bloodborne Pathogens Standard (29 CFR 1910.1030) requirements for medspas
- Sharps disposal and biohazard waste management
- Infection control protocols for aesthetic procedures
- Personal protective equipment (PPE) requirements
- Exposure control plan requirements
- Employee training and recordkeeping obligations
- OSHA inspection process and common citations for medical practices
- Hazard communication for chemicals used in aesthetics (peels, disinfectants)
- Emergency action plan requirements
- Recent OSHA guidance or rule changes affecting healthcare settings`),
    qualityCriteria: ["cfr_citation", "specific_requirements", "training_obligations"],
    intentKeywords: ["OSHA", "bloodborne", "sharps", "infection control", "biohazard", "PPE", "workplace safety", "exposure"],
  },
  {
    category: "hipaa_compliance",
    label: "HIPAA Compliance",
    scope: "national",
    refreshCadenceDays: 30,
    researchPromptTemplate: nationalPrompt("HIPAA Compliance for Medical Aesthetic Practices", `Research:
- HIPAA Privacy Rule requirements for medspas (PHI handling, minimum necessary)
- Security Rule requirements (administrative, physical, technical safeguards)
- Breach notification requirements and timelines
- Business Associate Agreement (BAA) requirements and who needs one
- Patient consent and authorization for photos, marketing, social media
- Telehealth-specific HIPAA considerations
- Employee training requirements and documentation
- Common HIPAA violations in aesthetic practices
- Electronic health record (EHR) compliance requirements
- Social media do's and don'ts with patient information
- Recent HHS enforcement actions and guidance updates`),
    qualityCriteria: ["regulation_citation", "specific_requirements", "penalty_info"],
    intentKeywords: ["HIPAA", "privacy", "PHI", "breach", "BAA", "consent", "patient photos", "security rule"],
  },
  {
    category: "treatment_technology",
    label: "Treatment Technology & Devices",
    scope: "national",
    refreshCadenceDays: 14,
    researchPromptTemplate: nationalPrompt("Latest Aesthetic Treatment Technologies & Devices", `Research the CURRENT state of aesthetic treatment technology (2025-2026):
- New FDA-cleared devices and treatments in the past 12 months
- Emerging technologies in non-surgical aesthetics (exosomes, polynucleotides, skin boosters)
- RF microneedling advances and new devices
- Body contouring technology updates (CoolSculpting Elite, Emsculpt NEO, etc.)
- Laser technology advances (picosecond, fractional, vascular)
- Injectable trends (longer-lasting fillers, biostimulators, toxin developments)
- Regenerative aesthetics (PRP/PRF, stem cells, growth factors)
- Skin analysis and diagnostic technology
- Energy-based device comparison and ROI analysis
- What's gaining traction vs. what's losing relevance`),
    qualityCriteria: ["fda_clearance_status", "clinical_evidence", "device_names", "treatment_specifics"],
    intentKeywords: ["new treatment", "device", "technology", "FDA", "laser", "RF microneedling", "body contouring", "filler", "biostimulator", "exosome"],
  },
  {
    category: "standards_of_care",
    label: "Standards of Care & Protocols",
    scope: "national",
    refreshCadenceDays: 21,
    researchPromptTemplate: nationalPrompt("Standards of Care for Medical Aesthetic Procedures", `Research:
- Current clinical protocols for common aesthetic procedures (neurotoxin injection, dermal fillers, chemical peels, microneedling, laser treatments)
- Safety guidelines and emergency protocols for aesthetic complications
- Complication management (vascular occlusion, allergic reaction, infection, scarring)
- Pre-treatment assessment and contraindication screening
- Post-treatment care protocols and patient instructions
- Documentation standards and medical record requirements
- Informed consent best practices and required elements
- Product storage, handling, and expiration management
- Combination treatment protocols and safety intervals
- Quality assurance and adverse event reporting`),
    qualityCriteria: ["clinical_protocol", "safety_guidelines", "complication_management"],
    intentKeywords: ["protocol", "standard of care", "complication", "emergency", "consent", "contraindication", "adverse event", "safety"],
  },
  {
    category: "hiring_staffing",
    label: "Hiring & Staffing",
    scope: "national",
    refreshCadenceDays: 30,
    researchPromptTemplate: nationalPrompt("Hiring & Staffing for Medical Aesthetic Practices", `Research:
- Current compensation benchmarks for aesthetic practice roles (NP injectors, estheticians, front desk, practice managers) by region
- Credentialing and privileging processes for aesthetic providers
- Onboarding best practices for clinical and non-clinical staff
- Independent contractor vs. employee classification (IRS guidelines, common pitfalls)
- Non-compete and non-solicitation agreements in healthcare
- Performance metrics and KPIs for aesthetic staff
- Training programs and continuing education requirements
- Team structure models for practices at different revenue levels
- Recruitment strategies for aesthetic NPs and estheticians
- Retention and culture-building in small practices`),
    qualityCriteria: ["compensation_data", "legal_requirements", "specific_benchmarks"],
    intentKeywords: ["hire", "staff", "salary", "compensation", "credential", "onboard", "contractor", "employee", "non-compete", "team structure"],
  },
  {
    category: "business_strategy",
    label: "Business Strategy & Scaling",
    scope: "national",
    refreshCadenceDays: 21,
    researchPromptTemplate: nationalPrompt("Business Strategy & Scaling for Medical Aesthetic Practices", `Research:
- Revenue benchmarks by practice size and geography (solo, small group, multi-location)
- Membership and subscription models for aesthetic practices (structure, pricing, retention)
- KPIs every medspa should track (with benchmark ranges)
- Scaling strategies: when to add providers, services, locations
- Exit planning and practice valuation methods for medspas
- Cash flow management in seasonal aesthetics businesses
- Vendor negotiation strategies for injectables and devices
- Equipment financing and leasing best practices
- Strategic partnerships and referral networks
- Current industry M&A trends and valuations`),
    qualityCriteria: ["revenue_benchmarks", "specific_strategies", "industry_data"],
    intentKeywords: ["strategy", "scale", "grow", "membership", "KPI", "benchmark", "valuation", "exit", "cash flow", "vendor"],
  },
  {
    category: "marketing_strategy",
    label: "Marketing Strategy & Patient Acquisition",
    scope: "national",
    refreshCadenceDays: 21,
    researchPromptTemplate: nationalPrompt("Marketing Strategy & Patient Acquisition for MedSpas", `Research current best practices (2025-2026):
- Facebook/Meta advertising strategies for medspas (audience targeting, ad formats, budgets, CPL benchmarks)
- Google Ads and local SEO for aesthetic practices
- Social media content strategy (Instagram, TikTok, YouTube) for practitioners
- Email marketing and patient nurture sequences
- Referral program structures that work
- Google Business Profile optimization for medspas
- Review generation and reputation management
- Website conversion optimization for aesthetic practices
- Patient acquisition cost benchmarks by channel
- Seasonal marketing calendar and promotional strategies
- Content marketing for authority building`),
    qualityCriteria: ["specific_benchmarks", "platform_specifics", "cost_data", "actionable_tactics"],
    intentKeywords: ["marketing", "Facebook ad", "Instagram", "SEO", "Google ad", "patient acquisition", "referral", "reviews", "content marketing", "social media"],
  },
  {
    category: "revenue_optimization",
    label: "Revenue Optimization",
    scope: "national",
    refreshCadenceDays: 30,
    researchPromptTemplate: nationalPrompt("Revenue Optimization for Medical Aesthetic Practices", `Research:
- Treatment packaging and bundling strategies with pricing examples
- Upselling and cross-selling frameworks for aesthetic consultations
- Inventory management and COGS optimization for injectables
- Pricing strategy (premium positioning, value-based pricing, anchor pricing)
- Average revenue per patient benchmarks by service category
- Treatment plan compliance and rebooking strategies
- Gift card and prepaid package programs
- Seasonal promotion strategies and their ROI
- Product retail as a revenue stream (skincare lines, at-home devices)
- Financial metrics: profit margins by service, break-even analysis, contribution margin`),
    qualityCriteria: ["pricing_examples", "margin_data", "specific_strategies"],
    intentKeywords: ["pricing", "package", "bundle", "upsell", "revenue", "profit margin", "inventory", "retail", "gift card", "average ticket"],
  },
  {
    category: "patient_experience",
    label: "Patient Experience & Retention",
    scope: "national",
    refreshCadenceDays: 30,
    researchPromptTemplate: nationalPrompt("Patient Experience & Retention for Aesthetic Practices", `Research:
- Patient intake and consultation process best practices
- Informed consent workflow and documentation
- Patient communication (pre-treatment, post-treatment, follow-up cadence)
- Retention metrics and benchmarks for aesthetic practices
- Loyalty and rewards program structures
- Patient satisfaction measurement (NPS, surveys, review monitoring)
- Handling negative reviews and patient complaints
- Patient education and expectation management
- Rebooking and recall systems that improve retention
- Technology: patient portals, online booking, text reminders
- VIP and membership experience design`),
    qualityCriteria: ["retention_benchmarks", "specific_workflows", "communication_templates"],
    intentKeywords: ["patient experience", "retention", "loyalty", "satisfaction", "intake", "follow up", "rebook", "recall", "complaint", "review response"],
  },
];

// Helpers
export function getStateTopics(): TopicConfig[] {
  return TOPIC_REGISTRY.filter(t => t.scope === "state");
}

export function getNationalTopics(): TopicConfig[] {
  return TOPIC_REGISTRY.filter(t => t.scope === "national");
}

export function getTopicByCategory(category: string): TopicConfig | undefined {
  return TOPIC_REGISTRY.find(t => t.category === category);
}

export function getAllCategories(): string[] {
  return TOPIC_REGISTRY.map(t => t.category);
}
