package main

import (
	"bytes"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

type CommitNode struct {
	Hash      string `json:"hash"`
	Branch    string `json:"branch"`
	Timestamp string `json:"timestamp"`
	Author    string `json:"author"`
	Subject   string `json:"subject"`
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
		assignLanes(order, branchTips, commits)
		if only == nil {
			// ponytail: name deleted lanes from merge msg / remotes / name-rev; reflog if still unnamed
			order = append(order, ensureMergeSourceLanes(root, branchTips, commits)...)
		}
	}

	nodes := make([]CommitNode, 0, len(commits))
	merges := make([]MergeEvent, 0)
	used := map[string]bool{}
	for _, c := range commits {
		if !c.assigned || c.branch == "" {
			continue
		}
		iso := c.at.Format(time.RFC3339)
		branch := c.branch
		target := c.branch
		if _, dst := parseMergeSubject(c.subject); dst != "" {
			if d := laneName(dst); d != "" {
				target = d
			}
		}
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
			srcBranch := ""
			if src != nil {
				srcBranch = src.branch
			}
			if srcBranch == "" {
				srcBranch, _ = parseMergeSubject(c.subject)
			}
			if srcBranch == "" {
				srcBranch = shortHash(srcHash)
			}
			if laneName(srcBranch) == laneName(target) {
				srcBranch = target
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
	out := make([]BranchInfo, 0, len(metas))
	for _, m := range metas {
		info := BranchInfo{Name: m.name}
		if !m.at.IsZero() {
			info.Updated = m.at.Format(time.RFC3339)
		}
		out = append(out, info)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
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
	const format = "--format=%(refname:short)%00%(objectname)%00%(committerdate:iso-strict)"
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
		} else if existing.hash != meta.hash {
			tips[name] = meta
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
		if len(parts) > 2 && parts[2] != "" {
			if at, err := time.Parse(time.RFC3339, parts[2]); err == nil {
				meta.at = at
			} else if at, err := time.Parse(time.RFC3339Nano, parts[2]); err == nil {
				meta.at = at
			}
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
	for _, name := range sortBranchNames(keys(tips)) {
		args := []string{"log", "--first-parent", "--pretty=format:%H%x1f%P%x1f%an%x1f%aI%x1f%s", tips[name]}
		if !since.IsZero() {
			args = append(args, "--since="+since.Format(time.RFC3339))
		}
		if !until.IsZero() {
			args = append(args, "--until="+until.Format(time.RFC3339))
		}
		chunk, err := parseLog(gitOutput(root, args...))
		if err != nil {
			return nil, err
		}
		for hash, c := range chunk {
			if commits[hash] != nil {
				continue
			}
			c.assigned = true
			c.branch = laneName(name)
			commits[hash] = c
		}
	}
	return commits, nil
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
		walk := tips[name]
		for walk != "" {
			c := commits[walk]
			if c == nil || c.assigned {
				break
			}
			c.assigned = true
			c.branch = laneName(name)
			if len(c.parents) == 0 {
				break
			}
			walk = c.parents[0]
		}
	}
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
	name = stripNameRev(stripRemotePrefix(name))
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
		return stripRemotePrefix(m[1]), strings.Trim(m[2], "'")
	}
	if m := mergeTag.FindStringSubmatch(s); m != nil {
		return m[1], strings.Trim(m[2], "'")
	}
	if m := mergePR.FindStringSubmatch(s); m != nil {
		return m[1], ""
	}
	if m := mergeBB.FindStringSubmatch(s); m != nil {
		return stripRemotePrefix(m[1]), ""
	}
	return "", ""
}

func stripNameRev(name string) string {
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
