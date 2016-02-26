'use strict';

const Promise = require('bluebird');
const log = require('npmlog');
const got = require('got');
const moment = require('moment');
const size = require('lodash/size');
const pointsToRanges = require('./util/pointsToRanges');
const promisePropsSettled = require('./util/promisePropsSettled');

const logPrefix = 'collect/npm';

/**
 * Fetches the download count from https://api.npmsjs.org/downloads
 *
 * @see https://github.com/npm/download-counts
 *
 * @param {string} name The module name
 *
 * @return {Promise} The promise for the downloads object
 */
function fetchDownloads(name) {
    const requestRange = {
        from: moment.utc().subtract(1, 'd').startOf('day').subtract(365, 'd').format('YYYY-MM-DD'),
        to: moment.utc().subtract(1, 'd').startOf('day').format('YYYY-MM-DD'),
    };
    const url = `https://api.npmjs.org/downloads/range/${requestRange.from}:${requestRange.to}/${name}`;

    return got(url, {
        json: true,
        timeout: 15000,
    })
    // Their API do not respect the HTTP status codes.. they response 200 OK even if the
    // request failed..
    .then((response) => {
        const error = response.body.error;

        if (!error) {
            return response.body.downloads;
        }

        // If there were no downloads, return an empty array
        if (/no stats for this package/i.test(error)) {
            return [];
        }

        throw new Error(error);
    })
    .catch((err) => {
        log.error(logPrefix, `Failed to fetch ${name} downloads`, { err, url });
        throw err;
    })
    .then((downloads) => {
        // Aggregate the data into ranges
        const points = downloads.map((entry) => { return { date: moment.utc(entry.day), count: entry.downloads }; });
        const ranges = pointsToRanges(points, pointsToRanges.bucketsFromBreakpoints([1, 7, 30, 90, 180, 365]));

        // Finally map to a prettier array based on the ranges, calculating the mean and count for each range
        return ranges.map((range) => {
            const downloadsCount = range.points.reduce((sum, point) => sum + point.count, 0);

            return {
                from: range.from,
                to: range.to,
                count: downloadsCount,
            };
        });
    });
}

/**
 * Fetches the dependents count.
 *
 * @param {string} name    The module name
 * @param {Nano}   npmNano The client nano instance for npm
 *
 * @return {Promise} The promise for the dependents count
 */
function fetchDependentsCount(name, npmNano) {
    return npmNano.viewAsync('app', 'dependedUpon', {
        startkey: [name],
        endkey: [name, {}],
        limit: 1,
        reduce: true,
        stale: 'update_after',
    })
    .then((res) => {
        return !res.rows.length ? 0 : res.rows[0].value;
    }, (err) => {
        log.error(logPrefix, `Failed to fetch ${name} dependents count from CouchDB`, { err });
        throw err;
    });
}

/**
 * Fetches the stars count.
 *
 * @param {object} data The module data
 *
 * @return {Promise} The promise for the stars count
 */
function fetchStarsCount(data) {
    // The users that starred are stored in the module data itself under the `users` property
    // We could get the document from the npm couchdb, but is unnecessary
    return Promise.resolve(data.users ? size(data.users) : 0);
}

// ----------------------------------------------------------------------------

/**
 * Runs the npm analyzer.
 *
 * @param {object} data    The module data
 * @param {Nano}   npmNano The client nano instance for npm
 *
 * @return {Promise} The promise that fulfills when done
 */
function npm(data, npmNano) {
    return promisePropsSettled({
        downloads: fetchDownloads(data.name, { timeout: 15000 }),
        dependentsCount: fetchDependentsCount(data.name, npmNano),
        starsCount: fetchStarsCount(data.name),
    });
}

module.exports = npm;