#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function consolidateAbout(data) {
  return {
    pageTitle: data.pageTitle,
    tagline: data.tagline,
    signUp: data.signUp,
    signIn: data.signIn,
    missionTitle: data.missionTitle,
    mission: data.mission,
    coreFeaturesTitle: data.coreFeaturesTitle,
    semanticContentTitle: data.semanticContentTitle,
    semanticContentSubtitle: data.semanticContentSubtitle,
    semanticContent: data.semanticContent,
    collaborationTitle: data.collaborationTitle,
    collaborationSubtitle: data.collaborationSubtitle,
    collaboration: data.collaboration,
    rbacTitle: data.rbacTitle,
    rbacSubtitle: data.rbacSubtitle,
    rbac: data.rbac,
    planned: data.planned,
    openSourceTitle: data.openSourceTitle,
    openSource: data.openSource,
    viewOnGitHub: data.viewOnGitHub,
    futureVisionTitle: data.futureVisionTitle,
    futureVision: data.futureVision,
  };
}

function consolidatePrivacy(data) {
  // Consolidate all list items into single strings
  const personalInfo = [
    data.personalInfoItem1,
    data.personalInfoItem2,
    data.personalInfoItem3,
  ].join('\n');

  const autoCollect = [
    data.autoCollectItem1,
    data.autoCollectItem2,
    data.autoCollectItem3,
    data.autoCollectItem4,
  ].join('\n');

  const howWeUse = [
    data.howWeUseItem1,
    data.howWeUseItem2,
    data.howWeUseItem3,
    data.howWeUseItem4,
    data.howWeUseItem5,
  ].join('\n');

  const gdprRights = [
    data.gdprRight1,
    data.gdprRight2,
    data.gdprRight3,
    data.gdprRight4,
    data.gdprRight5,
    data.gdprRight6,
    data.gdprRight7,
  ].join('\n');

  const ccpaRights = [
    data.ccpaRight1,
    data.ccpaRight2,
    data.ccpaRight3,
    data.ccpaRight4,
  ].join('\n');

  return {
    pageTitle: data.pageTitle,
    introTitle: data.introTitle,
    intro: data.intro,
    infoCollectTitle: data.infoCollectTitle,
    personalInfoTitle: data.personalInfoTitle,
    personalInfo,
    autoCollectTitle: data.autoCollectTitle,
    autoCollect,
    howWeUseTitle: data.howWeUseTitle,
    howWeUse,
    cookiePolicyTitle: data.cookiePolicyTitle,
    cookiePolicyIntro: data.cookiePolicyIntro,
    cookieCategoriesTitle: data.cookieCategoriesTitle,
    necessaryCookiesTitle: data.necessaryCookiesTitle,
    necessaryCookies: data.necessaryCookies,
    analyticsCookiesTitle: data.analyticsCookiesTitle,
    analyticsCookies: data.analyticsCookies,
    marketingCookiesTitle: data.marketingCookiesTitle,
    marketingCookies: data.marketingCookies,
    preferenceCookiesTitle: data.preferenceCookiesTitle,
    preferenceCookies: data.preferenceCookies,
    yourRightsTitle: data.yourRightsTitle,
    gdprRightsTitle: data.gdprRightsTitle,
    gdprRights,
    ccpaRightsTitle: data.ccpaRightsTitle,
    ccpaRights,
    dataSecurityTitle: data.dataSecurityTitle,
    dataSecurity: data.dataSecurity,
    dataRetentionTitle: data.dataRetentionTitle,
    dataRetention: data.dataRetention,
    internationalTransfersTitle: data.internationalTransfersTitle,
    internationalTransfers: data.internationalTransfers,
    contactTitle: data.contactTitle,
    contactIntro: data.contactIntro,
    contactEmail: data.contactEmail,
    contactAddress: data.contactAddress,
    updatesTitle: data.updatesTitle,
    updates: data.updates,
    lastUpdated: data.lastUpdated,
  };
}

function consolidateTerms(data) {
  // Consolidate all prohibited content items
  const prohibited = [
    data.prohibitedIllegal,
    data.prohibitedMinors,
    data.prohibitedAdult,
    data.prohibitedViolence,
    data.prohibitedHate,
    data.prohibitedMisinfo,
    data.prohibitedPrivacy,
    data.prohibitedIP,
    data.prohibitedMalicious,
    data.prohibitedSpam,
  ].join('\n');

  // Consolidate AI Alliance principles
  const aiAlliance = [
    data.aiAlliance1,
    data.aiAlliance2,
    data.aiAlliance3,
    data.aiAlliance4,
    data.aiAlliance5,
  ].join('\n');

  // Consolidate responsibilities
  const responsibilities = [
    data.responsibility1,
    data.responsibility2,
    data.responsibility3,
    data.responsibility4,
    data.responsibility5,
    data.responsibility6,
  ].join('\n');

  return {
    pageTitle: data.pageTitle,
    pageSubtitle: data.pageSubtitle,
    aupTitle: data.aupTitle,
    aup: data.aupIntro,
    prohibitedTitle: data.prohibitedTitle,
    prohibitedIntro: data.prohibitedIntro,
    prohibited,
    aiAllianceTitle: data.aiAllianceTitle,
    aiAllianceIntro: data.aiAllianceIntro,
    aiAllianceLink: data.aiAllianceLink,
    aiAllianceIncludes: data.aiAllianceIncludes,
    aiAlliance,
    responsibilitiesTitle: data.responsibilitiesTitle,
    responsibilitiesIntro: data.responsibilitiesIntro,
    responsibilities,
    moderationTitle: data.moderationTitle,
    moderation: data.moderation,
    privacyTitle: data.privacyTitle,
    privacy: data.privacy,
    privacyLink: data.privacyLink,
    ipTitle: data.ipTitle,
    ip: data.ip,
    liabilityTitle: data.liabilityTitle,
    liability: data.liability,
    changesTitle: data.changesTitle,
    changes: data.changes,
    contactTitle: data.contactTitle,
    contact: data.contact,
    lastUpdated: data.lastUpdated,
  };
}

function processFile(filePath, locale) {
  console.log(`\nProcessing ${locale}...`);
  const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

  const oldAboutKeys = Object.keys(data.About).length;
  const oldPrivacyKeys = Object.keys(data.Privacy).length;
  const oldTermsKeys = Object.keys(data.Terms).length;

  // Consolidate each section
  const newData = {
    ...data,
    About: consolidateAbout(data.About),
    Privacy: consolidatePrivacy(data.Privacy),
    Terms: consolidateTerms(data.Terms),
  };

  const newAboutKeys = Object.keys(newData.About).length;
  const newPrivacyKeys = Object.keys(newData.Privacy).length;
  const newTermsKeys = Object.keys(newData.Terms).length;

  // Write back
  fs.writeFileSync(filePath, JSON.stringify(newData, null, 2) + '\n', 'utf8');

  console.log(`  About: ${oldAboutKeys} → ${newAboutKeys} keys (${oldAboutKeys - newAboutKeys} removed)`);
  console.log(`  Privacy: ${oldPrivacyKeys} → ${newPrivacyKeys} keys (${oldPrivacyKeys - newPrivacyKeys} removed)`);
  console.log(`  Terms: ${oldTermsKeys} → ${newTermsKeys} keys (${oldTermsKeys - newTermsKeys} removed)`);
}

// Process both files
const enPath = path.join(__dirname, 'en.json');
const esPath = path.join(__dirname, 'es.json');

console.log('Aggressively consolidating prose sections...');
processFile(enPath, 'EN');
processFile(esPath, 'ES');

console.log('\n✅ Aggressive consolidation complete!');
