-- Global baseline rule set (spec Appendix A, tuned v3 + technology rules). New clients get a published copy.
insert into public.ruleset_versions (client_id, label, status, rules, notes)
values (null, 'SEED-2026-09-v4', 'published', $rules$[
 {
  "rule_id": "CAT-OPS-OVERFLOW",
  "category": "Operational",
  "subcategory": "Overflow case",
  "report_bucket": "Other",
  "pattern": "^overflow case$",
  "precedence": 100,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-OPS-SIMU",
  "category": "Operational",
  "subcategory": "Simulation",
  "report_bucket": "Other",
  "pattern": "\\bsimulat(ed|ion)\\b|\\bphish test\\b|\\battack simulation\\b",
  "precedence": 110,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-CRWD-IDP",
  "category": "CrowdStrike",
  "subcategory": "Identity Protection",
  "report_bucket": "CS Identity",
  "pattern": "\\bcrowd ?strike( falcon)? identity\\b|^(hd|oc)\\d+ cs\\b",
  "precedence": 200,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-CRWD-01",
  "category": "CrowdStrike",
  "subcategory": "Falcon detection",
  "report_bucket": "CrowdStrike",
  "pattern": "\\bcrowd ?strike\\b|\\bfalcon\\b|\\boverwatch\\b",
  "precedence": 210,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-PFPT-01",
  "category": "Proofpoint",
  "subcategory": "Email security",
  "report_bucket": "Proofpoint",
  "pattern": "\\bproof ?point\\b|\\bpps\\b",
  "precedence": 220,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-ABNL-01",
  "category": "Abnormal",
  "subcategory": "Email security",
  "report_bucket": "Abnormal",
  "pattern": "^(hd|oc)\\d+ abnormal\\b|\\babnormal security\\b",
  "precedence": 230,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-PANW-01",
  "category": "Palo Alto",
  "subcategory": "Network security",
  "report_bucket": "Palo Alto",
  "pattern": "\\bpalo ?alto\\b|\\bpan ?os\\b|\\bglobal ?protect\\b|\\bwildfire\\b|\\bcortex xdr\\b",
  "precedence": 240,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-DRKT-01",
  "category": "Darktrace",
  "subcategory": "NDR",
  "report_bucket": "Other",
  "pattern": "\\bdark ?trace\\b",
  "precedence": 250,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-TANM-01",
  "category": "Tanium",
  "subcategory": "Endpoint management",
  "report_bucket": "Other",
  "pattern": "\\btanium\\b",
  "precedence": 251,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-SAIL-01",
  "category": "SailPoint",
  "subcategory": "Identity governance",
  "report_bucket": "Other",
  "pattern": "\\bsail ?point\\b|\\bidentity ?iq\\b|\\bidentity ?now\\b",
  "precedence": 252,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-CARK-01",
  "category": "CyberArk",
  "subcategory": "PAM",
  "report_bucket": "Other",
  "pattern": "\\bcyber ?ark\\b",
  "precedence": 253,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-ZSCL-01",
  "category": "Zscaler",
  "subcategory": "SSE",
  "report_bucket": "Other",
  "pattern": "\\bz ?scaler\\b|\\bzia\\b|\\bzpa\\b",
  "precedence": 254,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-OKTA-01",
  "category": "Okta",
  "subcategory": "Identity",
  "report_bucket": "Other",
  "pattern": "\\bokta\\b",
  "precedence": 255,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-MIME-01",
  "category": "Mimecast",
  "subcategory": "Email security",
  "report_bucket": "Other",
  "pattern": "\\bmimecast\\b",
  "precedence": 256,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-NTSK-01",
  "category": "Netskope",
  "subcategory": "SSE",
  "report_bucket": "Other",
  "pattern": "\\bnetskope\\b",
  "precedence": 257,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-CSCO-01",
  "category": "Cisco",
  "subcategory": "Network security",
  "report_bucket": "Other",
  "pattern": "\\bcisco\\b|\\bumbrella\\b|\\bfirepower\\b|\\bcisco duo\\b",
  "precedence": 258,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-FTNT-01",
  "category": "Fortinet",
  "subcategory": "Network security",
  "report_bucket": "Other",
  "pattern": "\\bforti ?(gate|net|analyzer|client|edr)\\b",
  "precedence": 259,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-AWS-01",
  "category": "AWS",
  "subcategory": "Cloud",
  "report_bucket": "Other",
  "pattern": "\\baws\\b|\\bguard ?duty\\b|\\bcloud ?trail\\b|\\bamazon (s3|ec2|iam)\\b",
  "precedence": 260,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-AXON-01",
  "category": "Axonius",
  "subcategory": "Asset management",
  "report_bucket": "Other",
  "pattern": "\\baxonius\\b",
  "precedence": 261,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-SPLK-01",
  "category": "Splunk",
  "subcategory": "SIEM",
  "report_bucket": "Other",
  "pattern": "\\bsplunk\\b",
  "precedence": 262,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-CFLR-01",
  "category": "Cloudflare",
  "subcategory": "Edge security",
  "report_bucket": "SecOps Rule",
  "pattern": "\\bcloudflare\\b",
  "precedence": 263,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-SNOW-01",
  "category": "ServiceNow",
  "subcategory": "Ticketing",
  "report_bucket": "Other",
  "pattern": "\\bservice ?now\\b|\\bsnow (incident|ticket)\\b",
  "precedence": 264,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-JIRA-01",
  "category": "Jira",
  "subcategory": "Ticketing",
  "report_bucket": "Other",
  "pattern": "\\bjira\\b",
  "precedence": 265,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-GSO-ENTRA",
  "category": "Azure / Entra ID",
  "subcategory": "SecOps rule on Entra ID logs",
  "report_bucket": "SecOps Rule",
  "pattern": "^(hd|oc)\\d+ azure ?ad\\b|\\blst entra$",
  "precedence": 300,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-GSO-WINEVT",
  "category": "Windows / Active Directory",
  "subcategory": "SecOps rule on Windows Event Log",
  "report_bucket": "SecOps Rule",
  "pattern": "^(hd|oc)\\d+ winevtlog\\b",
  "precedence": 310,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-GSO-O365",
  "category": "Microsoft 365",
  "subcategory": "SecOps rule on Office 365 audit log",
  "report_bucket": "SecOps Rule",
  "pattern": "^(hd|oc)\\d+ office ?365\\b",
  "precedence": 320,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-GSO-GWS",
  "category": "Google Workspace",
  "subcategory": "SecOps rule on Workspace logs",
  "report_bucket": "SecOps Rule",
  "pattern": "\\blst workspace$",
  "precedence": 330,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-ENTRA-IDP",
  "category": "Azure / Entra ID",
  "subcategory": "Entra ID Protection",
  "report_bucket": "M365 Defender",
  "pattern": "^(unfamiliar sign in properties|anonymous ip address|atypical travel|anomalous token|password spray)$|\\bentra id\\b|\\bazure ad identity protection\\b|\\baitm\\b",
  "precedence": 400,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-MDO-01",
  "category": "M365 Defender",
  "subcategory": "Defender for Office 365",
  "report_bucket": "M365 Defender",
  "pattern": "\\bremoved after delivery\\b|\\breported by user as\\b|\\bpotentially malicious url click\\b",
  "precedence": 410,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-MDEF-01",
  "category": "M365 Defender",
  "subcategory": "Defender XDR / Cloud Apps",
  "report_bucket": "M365 Defender",
  "pattern": "^delegate access$|^administrative action submitted by an administrator$|\\bexchange online\\b|\\b(m365|microsoft 365|microsoft) defender\\b|\\bdefender for (endpoint|office 365|identity|cloud apps)\\b",
  "precedence": 420,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-MDEF-02",
  "category": "M365 Defender",
  "subcategory": "Defender XDR alert",
  "report_bucket": "M365 Defender",
  "pattern": "\\bbrowser credential recon\\b|\\bazure ad threat intelligence\\b|^dlp policy\\b.*\\bmatched for email\\b|\\bvisualbasic script executing a shell\\b|\\bwebserver process potential webshell\\b|\\bmalware was prevented\\b|\\bsuspicious wget invocation\\b|\\bsuspicious mail validation\\b|\\bmail bombing\\b|\\bsuspicious wmi shadow class\\b",
  "precedence": 430,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-GSO-CUSTOM",
  "category": "Google SecOps",
  "subcategory": "Custom rule",
  "report_bucket": "SecOps Rule",
  "pattern": "^(hd|oc)\\d+ ",
  "precedence": 500,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-GSO-CURATED",
  "category": "Google SecOps",
  "subcategory": "Curated detection",
  "report_bucket": "SecOps Curated",
  "pattern": "\\bmshta\\b|\\brundll32\\b|\\bregsvr32\\b|\\bpowershell\\b|\\bbeacon\\b|\\bqakbot\\b|\\bunc\\d{3,4}\\b|\\bcommand line detected\\b|\\bscheduled task\\b|\\bvaultcmd\\b|\\busebaseparsing\\b|\\bappdata\\b|\\btemplate directory\\b|\\bc2 top level domains\\b|\\bparent outlook\\b|\\bcredential scanning\\b|\\banydesk\\b|\\bnode exe\\b|\\bweb server process\\b|\\bapi traffic\\b|\\bwindows event logs\\b|\\bidman\\b",
  "precedence": 600,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Seed v3 (tuned on June/July 2026 exports)",
  "sample_titles": []
 },
 {
  "rule_id": "CAT-WINE-01",
  "category": "Windows Event",
  "subcategory": "Account lockout / logon failure",
  "report_bucket": "Other",
  "pattern": "\\baccount ?lock ?out(s|ed)?\\b|\\bexcessive ?lockouts?\\b|\\bfailed ?log[io]ns?\\b|\\blogon ?failure\\b|\\bbrute ?force\\b",
  "precedence": 700,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Spec v2.0 Appendix A.2 technology rule; fires only when no vendor or SecOps rule matched",
  "sample_titles": [
   "account_lockouts detected on DC01",
   "account_lockouts threshold exceeded for svc_backup"
  ]
 },
 {
  "rule_id": "CAT-WINE-02",
  "category": "Windows Event",
  "subcategory": "Windows telemetry",
  "report_bucket": "Other",
  "pattern": "\\bpower ?shell\\b|\\bwmi\\b|\\bsysmon\\b|\\bwindows ?event\\b|\\bevent ?id ?\\d{3,4}\\b|\\b(4624|4625|4672|4720|4740|4768|4769)\\b",
  "precedence": 710,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Spec v2.0 Appendix A.2 technology rule; fires only when no vendor or SecOps rule matched",
  "sample_titles": [
   "Windows event 4740 on member server"
  ]
 },
 {
  "rule_id": "CAT-ADIR-01",
  "category": "Active Directory",
  "subcategory": "Directory services",
  "report_bucket": "Other",
  "pattern": "\\bactive ?directory\\b|\\bdomain ?controller\\b|\\bkerberoast(ing)?\\b|\\bdcsync\\b|\\bldap\\b|\\bgolden ?ticket\\b",
  "precedence": 720,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Spec v2.0 Appendix A.2 technology rule; fires only when no vendor or SecOps rule matched",
  "sample_titles": [
   "Possible DCSync from workstation"
  ]
 },
 {
  "rule_id": "CAT-MAIL-01",
  "category": "Email Security",
  "subcategory": "Email threat",
  "report_bucket": "Other",
  "pattern": "\\bphish(ing)?\\b|\\bspam\\b|\\bdmarc\\b|\\bspf\\b|\\bdkim\\b|\\bmail ?flow\\b|\\bbusiness ?email ?compromise\\b|\\bbec\\b",
  "precedence": 730,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Spec v2.0 Appendix A.2 technology rule; fires only when no vendor or SecOps rule matched",
  "sample_titles": [
   "Suspected phishing email reported"
  ]
 },
 {
  "rule_id": "CAT-NETW-01",
  "category": "Network Security",
  "subcategory": "Network threat",
  "report_bucket": "Other",
  "pattern": "\\bfirewall\\b|\\bids\\b|\\bips\\b|\\bport ?scan\\b|\\bc2\\b|\\bcommand ?and ?control\\b|\\bbeacon(ing)?\\b|\\bdns ?tunnel",
  "precedence": 740,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Spec v2.0 Appendix A.2 technology rule; fires only when no vendor or SecOps rule matched",
  "sample_titles": [
   "Internal port scan detected"
  ]
 },
 {
  "rule_id": "CAT-ENDP-01",
  "category": "Endpoint",
  "subcategory": "Endpoint threat",
  "report_bucket": "Other",
  "pattern": "\\bmalware\\b|\\bransomware\\b|\\btrojan\\b|\\bedr\\b|\\bendpoint\\b|\\bprocess ?injection\\b|\\bsuspicious ?process\\b",
  "precedence": 750,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Spec v2.0 Appendix A.2 technology rule; fires only when no vendor or SecOps rule matched",
  "sample_titles": [
   "Ransomware behaviour on file server"
  ]
 },
 {
  "rule_id": "CAT-CLOU-01",
  "category": "Cloud / SaaS",
  "subcategory": "SaaS activity",
  "report_bucket": "Other",
  "pattern": "\\bcasb\\b|\\bcloud ?app\\b|\\bo365\\b|\\bsharepoint\\b|\\bone ?drive\\b",
  "precedence": 760,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Spec v2.0 Appendix A.2 technology rule; fires only when no vendor or SecOps rule matched",
  "sample_titles": [
   "Mass download from SharePoint site"
  ]
 },
 {
  "rule_id": "CAT-VULN-01",
  "category": "Vulnerability",
  "subcategory": "Vulnerability management",
  "report_bucket": "Other",
  "pattern": "\\bvulnerabilit(y|ies)\\b|\\bcve \\d{4} \\d{4,7}\\b|\\bpatch ?compliance\\b|\\btenable\\b|\\bqualys\\b|\\brapid7\\b",
  "precedence": 770,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Spec v2.0 Appendix A.2 technology rule; fires only when no vendor or SecOps rule matched",
  "sample_titles": [
   "CVE-2026-12345 exploitation attempt"
  ]
 },
 {
  "rule_id": "CAT-DLP-01",
  "category": "Insider / DLP",
  "subcategory": "Data loss",
  "report_bucket": "Other",
  "pattern": "\\bdlp\\b|\\bdata ?loss\\b|\\bexfiltrat(e|ion)\\b|\\binsider ?(threat|risk)\\b",
  "precedence": 780,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Spec v2.0 Appendix A.2 technology rule; fires only when no vendor or SecOps rule matched",
  "sample_titles": [
   "Possible data exfiltration to personal cloud"
  ]
 },
 {
  "rule_id": "CAT-HLTH-01",
  "category": "Health / Maintenance",
  "subcategory": "Platform health",
  "report_bucket": "Other",
  "pattern": "\\bhealth ?check\\b|\\blog ?source ?(down|silent|failure)\\b|\\bingestion ?(lag|failure)\\b|\\bmaintenance\\b",
  "precedence": 790,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Spec v2.0 Appendix A.2 technology rule; fires only when no vendor or SecOps rule matched",
  "sample_titles": [
   "Log source silent for 6 hours"
  ]
 },
 {
  "rule_id": "CAT-AZUR-01",
  "category": "Azure / Entra ID",
  "subcategory": "Azure platform",
  "report_bucket": "Other",
  "pattern": "\\bazure\\b|\\bentra( id)?\\b|\\baad\\b|\\bconditional ?access\\b",
  "precedence": 795,
  "fields": [
   "title"
  ],
  "enabled": true,
  "case_sensitive": false,
  "notes": "Spec v2.0 Appendix A.2 technology rule; fires only when no vendor or SecOps rule matched",
  "sample_titles": [
   "Conditional Access policy modified"
  ]
 }
]$rules$::jsonb,
  'Seed rule set: vendor and SecOps rules tuned on the June/July 2026 exports, plus the spec v2.0 technology rules.');
