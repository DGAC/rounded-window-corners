/** @file Provides wrapper functions for printing out debug messages. */

import {getPref} from './settings.js';

/**
 * Log a message with a [PADSI] prefix, but only
 * when debug mode is enabled.
 */
export function logDebug(...args: unknown[]) {
    if (getPref('debug-mode')) {
        console.log(`[PADSI] ${args}`);
    }
}

/**
 * Log an error with a [PADSI] prefix.
 */
export function logError(...args: unknown[]) {
    console.error(`[PADSI] ${args}`);
}
