/* Any copyright is dedicated to the Public Domain.
   http://creativecommons.org/publicdomain/zero/1.0/ */

Cu.import("resource://gre/modules/PlacesDBUtils.jsm");
Cu.import("resource://gre/modules/XPCOMUtils.jsm");
Cu.import("resource://services-common/utils.js");
Cu.import("resource://services-sync/engines.js");
Cu.import("resource://services-sync/constants.js");
Cu.import("resource://services-sync/engines/history.js");
Cu.import("resource://services-sync/service.js");
Cu.import("resource://services-sync/util.js");

let engine;
let tracker;

add_task(async function setup() {
  initTestLogging("Trace");
  Log.repository.getLogger("Sync.Tracker.History").level = Log.Level.Trace;

  Service.engineManager.clear();
  await Service.engineManager.register(HistoryEngine);
  engine = Service.engineManager.get("history");
  tracker = engine._tracker;

  // Don't write out by default.
  tracker.persistChangedIDs = false;
});

async function verifyTrackerEmpty() {
  let changes = await engine.pullNewChanges();
  do_check_empty(changes);
  equal(tracker.score, 0);
}

async function verifyTrackedCount(expected) {
  let changes = await engine.pullNewChanges();
  do_check_attribute_count(changes, expected);
}

async function verifyTrackedItems(tracked) {
  let changes = await engine.pullNewChanges();
  let trackedIDs = new Set(Object.keys(changes));
  for (let guid of tracked) {
    ok(guid in changes, `${guid} should be tracked`);
    ok(changes[guid] > 0, `${guid} should have a modified time`);
    trackedIDs.delete(guid);
  }
  equal(trackedIDs.size, 0, `Unhandled tracked IDs: ${
    JSON.stringify(Array.from(trackedIDs))}`);
}

async function startTracking() {
  Svc.Obs.notify("weave:engine:start-tracking");
}

async function stopTracking() {
  Svc.Obs.notify("weave:engine:stop-tracking");
}

async function resetTracker() {
  tracker.clearChangedIDs();
  tracker.resetScore();
}

async function cleanup() {
  await PlacesTestUtils.clearHistory();
  await resetTracker();
  await stopTracking();
}

add_task(async function test_empty() {
  _("Verify we've got an empty, disabled tracker to work with.");
  await verifyTrackerEmpty();
  do_check_false(tracker._isTracking);

  await cleanup();
});

add_task(async function test_not_tracking() {
  _("Create history item. Won't show because we haven't started tracking yet");
  await addVisit("not_tracking");
  await verifyTrackerEmpty();

  await cleanup();
});

add_task(async function test_start_tracking() {
  _("Add hook for save completion.");
  let savePromise = new Promise((resolve, reject) => {
    tracker.persistChangedIDs = true;
    let save = tracker._storage._save;
    tracker._storage._save = async function() {
      try {
        await save.call(this);
        resolve();
      } catch (ex) {
        reject(ex);
      } finally {
        // Turn this back off.
        tracker.persistChangedIDs = false;
        tracker._storage._save = save;
      }
    };
  });

  _("Tell the tracker to start tracking changes.");
  await startTracking();
  let scorePromise = promiseOneObserver("weave:engine:score:updated");
  await addVisit("start_tracking");
  await scorePromise;

  _("Score updated in test_start_tracking.");
  await verifyTrackedCount(1);
  do_check_eq(tracker.score, SCORE_INCREMENT_SMALL);

  await savePromise;

  _("changedIDs written to disk. Proceeding.");
  await cleanup();
});

add_task(async function test_start_tracking_twice() {
  _("Verifying preconditions.");
  await startTracking();
  await addVisit("start_tracking_twice1");
  await verifyTrackedCount(1);
  do_check_eq(tracker.score, SCORE_INCREMENT_SMALL);

  _("Notifying twice won't do any harm.");
  await startTracking();
  let scorePromise = promiseOneObserver("weave:engine:score:updated");
  await addVisit("start_tracking_twice2");
  await scorePromise;

  _("Score updated in test_start_tracking_twice.");
  await verifyTrackedCount(2);
  do_check_eq(tracker.score, 2 * SCORE_INCREMENT_SMALL);

  await cleanup();
});

add_task(async function test_track_delete() {
  _("Deletions are tracked.");

  // This isn't present because we weren't tracking when it was visited.
  await addVisit("track_delete");
  let uri = CommonUtils.makeURI("http://getfirefox.com/track_delete");
  let guid = await engine._store.GUIDForUri(uri.spec);
  await verifyTrackerEmpty();

  await startTracking();
  let visitRemovedPromise = promiseVisit("removed", uri);
  let scorePromise = promiseOneObserver("weave:engine:score:updated");
  await PlacesUtils.history.remove(uri);
  await Promise.all([scorePromise, visitRemovedPromise]);

  await verifyTrackedItems([guid]);
  do_check_eq(tracker.score, SCORE_INCREMENT_XLARGE);

  await cleanup();
});

add_task(async function test_dont_track_expiration() {
  _("Expirations are not tracked.");
  let uriToRemove = await addVisit("to_remove");
  let guidToRemove = await engine._store.GUIDForUri(uriToRemove.spec);

  await resetTracker();
  await verifyTrackerEmpty();

  await startTracking();
  let visitRemovedPromise = promiseVisit("removed", uriToRemove);
  let scorePromise = promiseOneObserver("weave:engine:score:updated");

  // Observe expiration.
  Services.obs.addObserver(function onExpiration(aSubject, aTopic, aData) {
    Services.obs.removeObserver(onExpiration, aTopic);
    // Remove the remaining page to update its score.
    PlacesUtils.history.remove(uriToRemove);
  }, PlacesUtils.TOPIC_EXPIRATION_FINISHED);

  // Force expiration of 1 entry.
  Services.prefs.setIntPref("places.history.expiration.max_pages", 0);
  Cc["@mozilla.org/places/expiration;1"]
    .getService(Ci.nsIObserver)
    .observe(null, "places-debug-start-expiration", 1);

  await Promise.all([scorePromise, visitRemovedPromise]);
  await verifyTrackedItems([guidToRemove]);

  await cleanup();
});

add_task(async function test_stop_tracking() {
  _("Let's stop tracking again.");
  await stopTracking();
  await addVisit("stop_tracking");
  await verifyTrackerEmpty();

  await cleanup();
});

add_task(async function test_stop_tracking_twice() {
  await stopTracking();
  await addVisit("stop_tracking_twice1");

  _("Notifying twice won't do any harm.");
  await stopTracking();
  await addVisit("stop_tracking_twice2");
  await verifyTrackerEmpty();

  await cleanup();
});

add_task(async function test_filter_file_uris() {
  await startTracking();

  let uri = CommonUtils.makeURI("file:///Users/eoger/tps/config.json");
  let visitAddedPromise = promiseVisit("added", uri);
  await PlacesTestUtils.addVisits({
    uri,
    visitDate: Date.now() * 1000,
    transition: PlacesUtils.history.TRANSITION_LINK
  });
  await visitAddedPromise;

  await verifyTrackerEmpty();
  await stopTracking();
  await cleanup();
});

add_task(async function test_filter_hidden() {
  await startTracking();

  _("Add visit; should be hidden by the redirect");
  let hiddenURI = await addVisit("hidden");
  let hiddenGUID = await engine._store.GUIDForUri(hiddenURI.spec);
  _(`Hidden visit GUID: ${hiddenGUID}`);

  _("Add redirect visit; should be tracked");
  let trackedURI = await addVisit("redirect", hiddenURI.spec,
    PlacesUtils.history.TRANSITION_REDIRECT_PERMANENT);
  let trackedGUID = await engine._store.GUIDForUri(trackedURI.spec);
  _(`Tracked visit GUID: ${trackedGUID}`);

  _("Add visit for framed link; should be ignored");
  let embedURI = await addVisit("framed_link", null,
    PlacesUtils.history.TRANSITION_FRAMED_LINK);
  let embedGUID = await engine._store.GUIDForUri(embedURI.spec);
  _(`Framed link visit GUID: ${embedGUID}`);

  _("Run Places maintenance to mark redirect visit as hidden");
  await PlacesDBUtils.maintenanceOnIdle();

  await verifyTrackedItems([trackedGUID]);

  await cleanup();
});
