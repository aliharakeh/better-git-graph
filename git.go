package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

type CommitNode struct {
	Hash      string   `json:"hash"`
	Branch    string   `json:"branch"`
	Timestamp string   `json:"timestamp"`
	Author    string   `json:"author"`
	Subject   string   `json:"subject"`
	IsMerge   bool     `json:"isMerge"`
	Tags      []string `json:"tags,omitempty"`
}

type MergeEvent struct {
	Hash         string `json:"hash"`
	SourceBranch string `json:"sourceBranch"`
	TargetBranch string `json:"targetBranch"`
	SourceHash   string `json:"sourceHash"`
	Timestamp    string `json:"timestamp"`
	Author       string `json:"author"`
	Subject      string `json:"subject"`
	CommitCount  int    `json:"commitCount"`
}

type RepoGraph struct {
	Path      string       `json:"path"`
	CommitURL string       `json:"commitUrl,omitempty"`
	Branches  []string     `json:"branches"`
	Commits   []CommitNode `json:"commits"`
	Merges    []MergeEvent `json:"merges"`
}

type BranchInfo struct {
	Name    string `json:"name"`
	Updated string `json:"updated,omitempty"`
}

type branchMeta struct {
	name string
	hash string
	at   time.Time
}

type rawCommit struct {
	hash     string
	parents  []string
	author   string
	at       time.Time
	subject  string
	branch   string
	assigned bool
	on       []string
}

var (
	mergeBranch = regexp.MustCompile(`(?i)^Merge(?: remote-tracking)? branch '([^']+)'(?: of \S+)?(?: into '?([^'\s]+)'?)?$`)
	mergeTag    = regexp.MustCompile(`(?i)^Merge tag '([^']+)'(?: into '?([^'\s]+)'?)?$`)
	mergePR     = regexp.MustCompile(`(?i)^Merge pull request #\d+ from [^/\s]+/(\S+?)(?: into \S+)?$`)
	mergeBB     = regexp.MustCompile(`(?i)^Merged in (\S+) \(pull request #\d+\)`)
	nameRevJunk = regexp.MustCompile(`([~^][\d]+)+$`)
)

func LoadGraph(path string) (*RepoGraph, error) {
	return loadGraph(path, nil)
}

func loadGraph(path string, only []string) (*RepoGraph, error) {
	return loadGraphAt(path, only, time.Time{}, time.Time{})
}

func loadGraphAt(path string, only []string, since, until time.Time) (*RepoGraph, error) {
	root, err := gitRoot(path)
	if err != nil {
		return nil, err
	}

	branchTips, err := listBranchTips(root)
	if err != nil {
		return nil, err
	}
	var revs []string
	if only != nil {
		branchTips = filterTips(branchTips, only)
		if len(branchTips) == 0 {
			return &RepoGraph{Path: root, CommitURL: commitURLPrefix(toWebBase(remoteURL(root)))}, nil
		}
		revs = values(branchTips)
	}
	windowed := !since.IsZero() || !until.IsZero()
	var commits map[string]*rawCommit
	if windowed {
		commits, err = listCommitsRange(root, branchTips, since, until)
	} else {
		commits, err = listCommits(root, revs)
	}
	if err != nil {
		return nil, err
	}
	tagByHash, err := listTags(root)
	if err != nil {
		return nil, err
	}

	order := sortBranchNames(keys(branchTips))
	if !windowed {
		assignLanes(claimOrder(order), branchTips, commits)
		assignOffSpineMerges(commits, order)
		if only == nil {
			// ponytail: name deleted lanes from merge msg / remotes / name-rev; reflog if still unnamed
			order = append(order, ensureMergeSourceLanes(root, branchTips, commits)...)
		}
	}

	nodes := make([]CommitNode, 0, len(commits))
	merges := make([]MergeEvent, 0)
	used := map[string]bool{}
	known := map[string]bool{}
	for _, name := range order {
		known[laneName(name)] = true
	}
	for _, c := range commits {
		if !c.assigned || c.branch == "" {
			continue
		}
		iso := c.at.Format(time.RFC3339)
		msgSrc, msgDst := parseMergeSubject(c.subject)
		target := c.branch
		if d := knownLane(msgDst, known); d != "" {
			target = d
		} else if incomingMerge(c.subject) {
			target = incomingDest(c, msgSrc, known)
		} else if laneName(msgDst) == "" {
			if s := knownLane(msgSrc, known); s != "" && s == laneName(c.branch) {
				target = s
			}
		}
		branch := c.branch
		if len(c.parents) > 1 {
			branch = target
		}
		used[branch] = true
		nodes = append(nodes, CommitNode{
			Hash:      c.hash,
			Branch:    branch,
			Timestamp: iso,
			Author:    c.author,
			Subject:   c.subject,
			IsMerge:   len(c.parents) > 1,
			Tags:      tagByHash[c.hash],
		})
		if len(c.parents) < 2 {
			continue
		}
		for _, srcHash := range c.parents[1:] {
			src := commits[srcHash]
			srcBranch := laneName(msgSrc)
			if srcBranch == "" && src != nil {
				srcBranch = src.branch
			}
			if srcBranch == "" {
				srcBranch = shortHash(srcHash)
			}
			srcBranch = laneName(srcBranch)
			if srcBranch == laneName(target) {
				srcBranch = target
			} else if srcBranch != "" {
				used[srcBranch] = true
			}
			merges = append(merges, MergeEvent{
				Hash:         c.hash,
				SourceBranch: srcBranch,
				TargetBranch: target,
				SourceHash:   srcHash,
				Timestamp:    iso,
				Author:       c.author,
				Subject:      c.subject,
				CommitCount:  countExclusive(srcHash, c.parents[0], commits),
			})
		}
	}

	branches := make([]string, 0, len(order))
	seenBr := map[string]bool{}
	for _, name := range order {
		lane := laneName(name)
		if used[lane] && !seenBr[lane] {
			seenBr[lane] = true
			branches = append(branches, lane)
		}
	}
	var rest []string
	for lane := range used {
		if !seenBr[lane] {
			rest = append(rest, lane)
		}
	}
	sort.Strings(rest)
	branches = append(branches, rest...)

	sort.Slice(nodes, func(i, j int) bool {
		if nodes[i].Timestamp == nodes[j].Timestamp {
			return nodes[i].Hash < nodes[j].Hash
		}
		return nodes[i].Timestamp < nodes[j].Timestamp
	})
	sort.Slice(merges, func(i, j int) bool {
		return merges[i].Timestamp < merges[j].Timestamp
	})

	return &RepoGraph{Path: root, CommitURL: commitURLPrefix(toWebBase(remoteURL(root))), Branches: branches, Commits: nodes, Merges: merges}, nil
}

func ListBranches(path string) ([]BranchInfo, error) {
	root, err := gitRoot(path)
	if err != nil {
		return nil, err
	}
	metas, err := listBranchMeta(root)
	if err != nil {
		return nil, err
	}
	sort.Slice(metas, func(i, j int) bool {
		if !metas[i].at.Equal(metas[j].at) {
			return metas[i].at.After(metas[j].at)
		}
		return metas[i].name < metas[j].name
	})
	out := make([]BranchInfo, 0, len(metas))
	for _, m := range metas {
		info := BranchInfo{Name: m.name}
		if !m.at.IsZero() {
			info.Updated = m.at.Format(time.RFC3339)
		}
		out = append(out, info)
	}
	return out, nil
}

func gitRoot(path string) (string, error) {
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(abs)
	if err != nil {
		return "", fmt.Errorf("path not found: %w", err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("not a directory: %s", abs)
	}
	root, err := gitOutput(abs, "rev-parse", "--show-toplevel")
	if err != nil {
		return "", fmt.Errorf("not a git repository: %s", abs)
	}
	return filepath.Clean(root), nil
}

func listBranchTips(root string) (map[string]string, error) {
	metas, err := listBranchMeta(root)
	if err != nil {
		return nil, err
	}
	tips := make(map[string]string, len(metas))
	for _, m := range metas {
		tips[m.name] = m.hash
	}
	return tips, nil
}

func listBranchMeta(root string) ([]branchMeta, error) {
	const format = "--format=%(refname:short)%00%(objectname)%00%(authordate:unix)%00%(committerdate:unix)"
	out, err := gitOutput(root, "for-each-ref", format, "refs/heads")
	if err != nil {
		return nil, err
	}
	tips := parseRefMeta(out)
	out, err = gitOutput(root, "for-each-ref", format, "refs/remotes")
	if err != nil {
		return nil, err
	}
	for name, meta := range parseRefMeta(out) {
		if strings.HasSuffix(name, "/HEAD") {
			continue
		}
		short := stripRemotePrefix(name)
		if existing, ok := tips[short]; !ok {
			meta.name = short
			tips[short] = meta
		} else {
			if meta.at.After(existing.at) {
				existing.at = meta.at
				tips[short] = existing
			}
			if existing.hash != meta.hash {
				tips[name] = meta
			}
		}
	}
	outMetas := make([]branchMeta, 0, len(tips))
	for _, m := range tips {
		outMetas = append(outMetas, m)
	}
	return outMetas, nil
}

func listTags(root string) (map[string][]string, error) {
	out, err := gitOutput(root, "for-each-ref", "--format=%(refname:short)%00%(*objectname)%00%(objectname)", "refs/tags")
	if err != nil {
		return nil, err
	}
	byHash := map[string][]string{}
	if out == "" {
		return byHash, nil
	}
	for _, line := range strings.Split(out, "\n") {
		parts := strings.Split(line, "\x00")
		if len(parts) < 3 || parts[0] == "" {
			continue
		}
		hash := parts[1]
		if hash == "" {
			hash = parts[2]
		}
		if hash == "" {
			continue
		}
		byHash[hash] = append(byHash[hash], parts[0])
	}
	for _, tags := range byHash {
		sort.Strings(tags)
	}
	return byHash, nil
}

func parseRefMeta(out string) map[string]branchMeta {
	tips := map[string]branchMeta{}
	if out == "" {
		return tips
	}
	for _, line := range strings.Split(out, "\n") {
		parts := strings.Split(line, "\x00")
		if len(parts) < 2 || parts[0] == "" || parts[1] == "" {
			continue
		}
		meta := branchMeta{name: parts[0], hash: parts[1]}
		unix := int64(0)
		for _, p := range parts[2:] {
			n, err := strconv.ParseInt(p, 10, 64)
			if err == nil && n > unix {
				unix = n
			}
		}
		if unix > 0 {
			meta.at = time.Unix(unix, 0)
		}
		tips[parts[0]] = meta
	}
	return tips
}

func filterTips(tips map[string]string, want []string) map[string]string {
	allow := map[string]bool{}
	for _, w := range want {
		if w == "" {
			continue
		}
		allow[w] = true
		allow[laneName(w)] = true
	}
	out := map[string]string{}
	for name, hash := range tips {
		if allow[name] || allow[laneName(name)] {
			out[name] = hash
		}
	}
	return out
}

func listCommits(root string, revs []string) (map[string]*rawCommit, error) {
	args := []string{"log", "--pretty=format:%H%x1f%P%x1f%an%x1f%aI%x1f%s"}
	if len(revs) == 0 {
		args = append(args, "--all")
	} else {
		args = append(args, revs...)
	}
	return parseLog(gitOutput(root, args...))
}

func listCommitsRange(root string, tips map[string]string, since, until time.Time) (map[string]*rawCommit, error) {
	commits := map[string]*rawCommit{}
	for _, name := range claimOrder(keys(tips)) {
		lane := laneName(name)
		chunk, err := parseLog(gitOutput(root, rangeLogArgs(tips[name], since, until, "--first-parent")...))
		if err != nil {
			return nil, err
		}
		for hash, c := range chunk {
			if existing := commits[hash]; existing != nil {
				markOn(existing, lane)
				continue
			}
			c.assigned = true
			c.branch = lane
			markOn(c, lane)
			commits[hash] = c
		}
		// first-parent misses merges that landed via "Merge branch 'dev' of remote into dev"
		side, err := parseLog(gitOutput(root, rangeLogArgs(tips[name], since, until, "--merges")...))
		if err != nil {
			return nil, err
		}
		for hash, c := range side {
			if existing := commits[hash]; existing != nil {
				continue
			}
			if !belongsOnLane(c, lane, commits) {
				continue
			}
			c.assigned = true
			c.branch = lane
			markOn(c, lane)
			commits[hash] = c
		}
	}
	return commits, nil
}

func rangeLogArgs(tip string, since, until time.Time, extra ...string) []string {
	args := append([]string{"log", "--pretty=format:%H%x1f%P%x1f%an%x1f%aI%x1f%s"}, extra...)
	args = append(args, tip)
	if !since.IsZero() {
		args = append(args, "--since="+since.Format(time.RFC3339))
	}
	if !until.IsZero() {
		args = append(args, "--until="+until.Format(time.RFC3339))
	}
	return args
}

func parseLog(out string, err error) (map[string]*rawCommit, error) {
	if err != nil {
		if strings.Contains(strings.ToLower(err.Error()), "does not have any commits") {
			return map[string]*rawCommit{}, nil
		}
		return nil, err
	}
	commits := map[string]*rawCommit{}
	if out == "" {
		return commits, nil
	}
	for _, line := range strings.Split(out, "\n") {
		parts := strings.SplitN(line, "\x1f", 5)
		if len(parts) < 4 {
			continue
		}
		subject := ""
		if len(parts) == 5 {
			subject = parts[4]
		}
		at, err := time.Parse(time.RFC3339, parts[3])
		if err != nil {
			at, err = time.Parse(time.RFC3339Nano, parts[3])
			if err != nil {
				continue
			}
		}
		var parents []string
		if parts[1] != "" {
			parents = strings.Fields(parts[1])
		}
		commits[parts[0]] = &rawCommit{
			hash:    parts[0],
			parents: parents,
			author:  parts[2],
			at:      at,
			subject: subject,
		}
	}
	return commits, nil
}

func assignLanes(order []string, tips map[string]string, commits map[string]*rawCommit) {
	for _, name := range order {
		lane := laneName(name)
		walk := tips[name]
		for walk != "" {
			c := commits[walk]
			if c == nil {
				break
			}
			markOn(c, lane)
			if !c.assigned {
				c.assigned = true
				c.branch = lane
			}
			if len(c.parents) == 0 {
				break
			}
			walk = c.parents[0]
		}
	}
}

func assignOffSpineMerges(commits map[string]*rawCommit, lanes []string) {
	known := map[string]bool{}
	for _, name := range lanes {
		known[laneName(name)] = true
	}
	for _, c := range commits {
		if c.assigned || len(c.parents) < 2 {
			continue
		}
		d := destLane(c.subject)
		if known[d] {
			c.assigned = true
			c.branch = d
			markOn(c, d)
			continue
		}
		if d != "" {
			continue
		}
		if p := commits[c.parents[0]]; p != nil && p.assigned && known[p.branch] {
			c.assigned = true
			c.branch = p.branch
			markOn(c, p.branch)
			continue
		}
		if len(known) != 1 || !(mergePR.MatchString(c.subject) || mergeBB.MatchString(c.subject)) {
			continue
		}
		for lane := range known {
			c.assigned = true
			c.branch = lane
			markOn(c, lane)
		}
	}
}

func destLane(subject string) string {
	_, dst := parseMergeSubject(subject)
	return dst
}

func belongsOnLane(c *rawCommit, lane string, commits map[string]*rawCommit) bool {
	d := destLane(c.subject)
	if d == lane {
		return true
	}
	if d != "" {
		return false
	}
	s := strings.ToLower(strings.TrimSpace(c.subject))
	l := strings.ToLower(lane)
	if strings.HasSuffix(s, " into "+l) || strings.HasSuffix(s, " into '"+l+"'") {
		return true
	}
	if len(c.parents) > 0 {
		if p := commits[c.parents[0]]; p != nil && p.assigned && p.branch == lane {
			return true
		}
	}
	if mergePR.MatchString(c.subject) || mergeBB.MatchString(c.subject) {
		return true
	}
	return false
}

func ensureMergeSourceLanes(root string, tips map[string]string, commits map[string]*rawCommit) []string {
	seen := map[string]bool{}
	for name := range tips {
		seen[laneName(name)] = true
	}
	type src struct{ hash, subject string }
	var pending []src
	for _, c := range commits {
		if len(c.parents) < 2 || !c.assigned {
			continue
		}
		for _, srcHash := range c.parents[1:] {
			parent := commits[srcHash]
			if parent == nil || (parent.assigned && parent.branch != "") {
				continue
			}
			pending = append(pending, src{srcHash, c.subject})
		}
	}
	var query []string
	for _, p := range pending {
		if name, _ := parseMergeSubject(p.subject); name == "" {
			query = append(query, p.hash)
		}
	}
	revs := nameRevs(root, query)
	var extra []string
	for _, p := range pending {
		name, fromMsg := mergeSourceName(p.subject, revs[p.hash])
		if name == "" {
			name = "lost/" + shortHash(p.hash)
		} else if seen[name] {
			if fromMsg {
				assignLanes([]string{name}, map[string]string{name: p.hash}, commits)
				continue
			}
			name = "lost/" + shortHash(p.hash)
		}
		if seen[name] {
			continue
		}
		seen[name] = true
		tips[name] = p.hash
		extra = append(extra, name)
	}
	sort.Strings(extra)
	assignLanes(extra, tips, commits)
	return extra
}

func mergeSourceName(subject, rev string) (name string, fromMsg bool) {
	name, _ = parseMergeSubject(subject)
	name = cleanLaneName(name)
	if name != "" {
		return name, true
	}
	return cleanLaneName(rev), false
}

func cleanLaneName(name string) string {
	name = stripRemotePrefix(stripNameRev(name))
	if name == "" || name == "undefined" {
		return ""
	}
	return name
}

func nameRevs(root string, hashes []string) map[string]string {
	if len(hashes) == 0 {
		return nil
	}
	out, err := gitOutputStdin(root, strings.Join(hashes, "\n")+"\n", "name-rev", "--name-only", "--stdin")
	if err != nil || out == "" {
		return nil
	}
	lines := strings.Split(out, "\n")
	names := make(map[string]string, len(hashes))
	for i, h := range hashes {
		if i >= len(lines) {
			break
		}
		names[h] = lines[i]
	}
	return names
}

func countExclusive(from, exclude string, commits map[string]*rawCommit) int {
	blocked := map[string]bool{}
	stack := []string{exclude}
	for len(stack) > 0 {
		h := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if h == "" || blocked[h] {
			continue
		}
		blocked[h] = true
		c := commits[h]
		if c == nil {
			continue
		}
		stack = append(stack, c.parents...)
	}
	n := 0
	stack = []string{from}
	seen := map[string]bool{}
	for len(stack) > 0 {
		h := stack[len(stack)-1]
		stack = stack[:len(stack)-1]
		if h == "" || blocked[h] || seen[h] {
			continue
		}
		seen[h] = true
		n++
		c := commits[h]
		if c == nil {
			continue
		}
		stack = append(stack, c.parents...)
	}
	return n
}

func parseMergeSubject(subject string) (src, dst string) {
	s := strings.TrimSpace(subject)
	if m := mergeBranch.FindStringSubmatch(s); m != nil {
		return cleanLaneName(m[1]), cleanLaneName(strings.Trim(m[2], "'"))
	}
	if m := mergeTag.FindStringSubmatch(s); m != nil {
		return cleanLaneName(m[1]), cleanLaneName(strings.Trim(m[2], "'"))
	}
	if m := mergePR.FindStringSubmatch(s); m != nil {
		return cleanLaneName(m[1]), ""
	}
	if m := mergeBB.FindStringSubmatch(s); m != nil {
		return cleanLaneName(m[1]), ""
	}
	return "", ""
}

func stripNameRev(name string) string {
	name = strings.TrimPrefix(name, "refs/heads/")
	name = strings.TrimPrefix(name, "refs/remotes/")
	name = strings.TrimPrefix(name, "refs/tags/")
	name = strings.TrimPrefix(name, "remotes/")
	name = strings.TrimPrefix(name, "tags/")
	return nameRevJunk.ReplaceAllString(name, "")
}

func stripRemotePrefix(name string) string {
	name = strings.TrimPrefix(name, "remotes/")
	if origin, rest, ok := strings.Cut(name, "/"); ok && (origin == "origin" || origin == "upstream") {
		return rest
	}
	return name
}

func laneName(name string) string {
	if s := cleanLaneName(name); s != "" {
		return s
	}
	return name
}

func sortBranchNames(names []string) []string {
	rank := map[string]int{"main": 0, "master": 1, "trunk": 2, "develop": 3, "dev": 4}
	sort.Slice(names, func(i, j int) bool {
		ri, okI := rank[names[i]]
		rj, okJ := rank[names[j]]
		if okI && okJ {
			return ri < rj
		}
		if okI != okJ {
			return okI
		}
		return names[i] < names[j]
	})
	return names
}

func claimOrder(names []string) []string {
	rank := map[string]int{"main": 1, "master": 1, "trunk": 1, "develop": 1, "dev": 1}
	out := append([]string{}, names...)
	sort.Slice(out, func(i, j int) bool {
		iTrunk := rank[laneName(out[i])]
		jTrunk := rank[laneName(out[j])]
		if iTrunk != jTrunk {
			return iTrunk < jTrunk
		}
		return out[i] < out[j]
	})
	return out
}

func knownLane(name string, known map[string]bool) string {
	name = laneName(name)
	if name != "" && known[name] {
		return name
	}
	return ""
}

func incomingMerge(subject string) bool {
	return mergeBB.MatchString(subject) || mergePR.MatchString(subject)
}

func incomingDest(c *rawCommit, msgSrc string, known map[string]bool) string {
	src := laneName(msgSrc)
	var other []string
	for _, lane := range c.on {
		if known[lane] && lane != src {
			other = append(other, lane)
		}
	}
	if t := pickTrunk(other); t != "" {
		return t
	}
	if len(other) > 0 {
		sort.Strings(other)
		return other[0]
	}
	return c.branch
}

func pickTrunk(lanes []string) string {
	for _, t := range []string{"dev", "develop", "main", "master", "trunk"} {
		for _, l := range lanes {
			if l == t {
				return t
			}
		}
	}
	return ""
}

func markOn(c *rawCommit, lane string) {
	for _, x := range c.on {
		if x == lane {
			return
		}
	}
	c.on = append(c.on, lane)
}

func keys(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	return out
}

func values(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for _, v := range m {
		out = append(out, v)
	}
	return out
}

func remoteURL(root string) string {
	if u, err := gitOutput(root, "remote", "get-url", "origin"); err == nil && u != "" {
		return u
	}
	names, err := gitOutput(root, "remote")
	if err != nil || names == "" {
		return ""
	}
	u, err := gitOutput(root, "remote", "get-url", strings.Fields(names)[0])
	if err != nil {
		return ""
	}
	return u
}

func toWebBase(remote string) string {
	u := strings.TrimSuffix(strings.TrimSuffix(strings.TrimSpace(remote), "/"), ".git")
	if u == "" {
		return ""
	}
	if rest, ok := strings.CutPrefix(u, "git@"); ok {
		host, path, ok := strings.Cut(rest, ":")
		if !ok || host == "" || path == "" {
			return ""
		}
		return "https://" + host + "/" + strings.TrimPrefix(path, "/")
	}
	if rest, ok := strings.CutPrefix(u, "ssh://"); ok {
		rest = strings.TrimPrefix(rest, "git@")
		return "https://" + rest
	}
	scheme, rest, ok := strings.Cut(u, "://")
	if !ok || (scheme != "http" && scheme != "https") {
		return ""
	}
	if at := strings.LastIndex(rest, "@"); at >= 0 {
		rest = rest[at+1:]
	}
	return scheme + "://" + rest
}

func commitURLPrefix(base string) string {
	if base == "" {
		return ""
	}
	host := base
	if _, rest, ok := strings.Cut(base, "://"); ok {
		host, _, _ = strings.Cut(rest, "/")
	}
	switch {
	case host == "bitbucket.org" || strings.HasSuffix(host, ".bitbucket.org"):
		return base + "/commits/"
	case host == "gitlab.com" || strings.Contains(host, "gitlab"):
		return base + "/-/commit/"
	default:
		return base + "/commit/"
	}
}

func shortHash(h string) string {
	if len(h) > 7 {
		return h[:7]
	}
	return h
}

func gitOutput(dir string, args ...string) (string, error) {
	return gitOutputStdin(dir, "", args...)
}

func gitOutputStdin(dir, input string, args ...string) (string, error) {
	cmd := exec.Command("git", append([]string{"-C", dir}, args...)...)
	if input != "" {
		cmd.Stdin = strings.NewReader(input)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("%s", msg)
	}
	return strings.TrimSpace(string(out)), nil
}
