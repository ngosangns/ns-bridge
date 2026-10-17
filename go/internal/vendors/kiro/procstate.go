package kiro

// The sidecar process lives for one call, so the profile-ARN cache and the
// cross-turn cache-read estimate live in a file the next call reads back.
// ~/.ns-kiro-provider-process-state.json, or KIRO_PROCESS_STATE_PATH.
// "off" leaves the call with an empty cache and nothing to write.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"time"

	"github.com/ngosangns/ns-bridge/go/internal/logx"
)

const processStateName = ".ns-kiro-provider-process-state.json"

type processState struct {
	ProfileArns     map[string]string `json:"profileArns,omitempty"`
	ProfileRegions  map[string]string `json:"profileRegions,omitempty"`
	Estimates       []cacheEstimate   `json:"estimates,omitempty"`
	WarnedWireCache bool              `json:"warnedWireCache,omitempty"`
}

func statePath() string {
	if p, ok := os.LookupEnv("KIRO_PROCESS_STATE_PATH"); ok {
		if p == "off" {
			return ""
		}
		return p
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, processStateName)
}

// peekProcessState is the file as of this moment. An unreadable file is empty.
func peekProcessState() processState {
	path := statePath()
	if path == "" {
		return processState{}
	}
	unlock := acquireStateLock(path)
	defer unlock()
	return readProcessState(path)
}

// updateProcessState applies fn to the file under the lock and writes it back.
func updateProcessState(fn func(*processState)) {
	path := statePath()
	if path == "" {
		st := &processState{}
		fn(st)
		return
	}
	unlock := acquireStateLock(path)
	defer unlock()
	st := readProcessState(path)
	fn(&st)
	if err := writeProcessState(path, &st); err != nil {
		logx.Warn("[kiro-core] Failed to write Kiro process state: " + err.Error())
	}
}

func readProcessState(path string) processState {
	raw, err := os.ReadFile(path)
	if err != nil || len(raw) == 0 {
		return processState{}
	}
	var st processState
	if json.Unmarshal(raw, &st) != nil {
		return processState{}
	}
	return st
}

func writeProcessState(path string, st *processState) error {
	raw, err := json.Marshal(st)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(path), ".kiro-state-*")
	if err != nil {
		return err
	}
	tmpName := tmp.Name()
	_, werr := tmp.Write(raw)
	cerr := tmp.Close()
	if werr != nil || cerr != nil {
		_ = os.Remove(tmpName)
		if werr != nil {
			return werr
		}
		return cerr
	}
	return os.Rename(tmpName, path)
}

// acquireStateLock takes path+".lock" as a directory. A lock older than five
// seconds is removed: the process that made it is gone. Past the deadline the
// call proceeds unlocked so a stuck lock cannot fail a model request.
func acquireStateLock(path string) func() {
	lock := path + ".lock"
	deadline := time.Now().Add(5 * time.Second)
	for {
		if err := os.Mkdir(lock, 0o700); err == nil {
			return func() { _ = os.Remove(lock) }
		}
		if info, err := os.Stat(lock); err == nil && time.Since(info.ModTime()) > 5*time.Second {
			_ = os.Remove(lock)
			continue
		}
		if time.Now().After(deadline) {
			return func() {}
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// writeTo folds this call's profile-cache delta into the on-disk state.
func (c *profileCache) writeTo(st *processState) {
	if st.ProfileArns == nil {
		st.ProfileArns = map[string]string{}
	}
	if st.ProfileRegions == nil {
		st.ProfileRegions = map[string]string{}
	}
	for k, v := range c.regionChanges {
		st.ProfileRegions[k] = v
	}
	for k, v := range c.changes {
		if v == nil {
			delete(st.ProfileArns, k)
			delete(st.ProfileRegions, k)
			continue
		}
		st.ProfileArns[k] = *v
	}
}
