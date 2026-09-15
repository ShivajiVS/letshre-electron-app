"use strict";

// constants.js now reads the interview and API hosts straight from the
// environment with no built-in fallback, so the suite has to supply them the
// same way a real launch does. Only fills what the caller hasn't already set.
process.env.INTERVIEW_FRONTEND_BASE_URL ||= "https://interview.letshyre.com";
process.env.API_BASE_URL ||= "https://api.letshyre.com";
