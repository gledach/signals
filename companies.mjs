// companies.mjs — compatibility shim.
//
// The registry moved: brand DATA is now config/companies.default.mjs (overridable with
// config/companies.local.mjs), and the matching ENGINE is core/registry.mjs. This file
// re-exports the loaded registry so the ~19 existing importers keep working while the
// restructure lands. New code should import from './config/companies.mjs' directly.

export {
  COMPANIES,
  COMPETITOR_IDS,
  OUR_COMPANY_ID,
  HAS_OUR_COMPANY,
  MARKETS,
  AMBIGUOUS_BARE_TOKENS,
  CONFIG_ORIGIN,
  CONFIG_FILE,
  getCompany,
  companiesInMarket,
  matchCompanyInText,
} from './config/companies.mjs';

export { default } from './config/companies.mjs';
