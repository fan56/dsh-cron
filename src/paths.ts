/**
 * dsh home resolution, mirroring dsh-vault's paths seam.
 *
 * @module dsh-cron/paths
 */

import { homedir } from 'node:os';
import { join } from 'node:path';

/** Resolve the dsh home ($DSH_HOME, else ~/.dsh). */
export function resolveDshHome(): string {
	return process.env.DSH_HOME ? process.env.DSH_HOME : join(homedir(), '.dsh');
}

/** Default profile-level cron store: <dsh home>/storages/cron (ADR 0001). */
export function defaultCronDir(): string {
	return join(resolveDshHome(), 'storages', 'cron');
}
