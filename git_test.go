package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestParseMergeSubject(t *testing.T) {
	cases := []struct {
		in, src, dst string
	}{
		{"Merge branch 'feature/login' into develop", "feature/login", "develop"},
		{"Merge branch 'hotfix/patch'", "hotfix/patch", ""},
		{"Merge pull request #12 from acme/feature/x", "feature/x", ""},
		{"Merge remote-tracking branch 'origin/feat' into main", "feat", "main"},
		{"Merge branch 'main' of https://github.com/acme/repo", "main", ""},
		{"Merge branch 'foo' of github.com:acme/repo into develop", "foo", "develop"},
		{"Merge branch 'foo' into 'bar'", "foo", "bar"},
		{"Merge tag 'v1.2.3' into main", "v1.2.3", "main"},
		{"Merged in feature/x (pull request #9)", "feature/x", ""},
		{"regular commit", "", ""},
	}
	for _, c := range cases {
		src, dst := parseMergeSubject(c.in)
		if src != c.src || dst != c.dst {
			t.Fatalf("%q: got %q/%q want %q/%q", c.in, src, dst, c.src, c.dst)
		}
	}
}

func TestCountExclusive(t *testing.T) {
	commits := map[string]*rawCommit{
		"A": {hash: "A"},
		"B": {hash: "B", parents: []string{"A"}},
		"C": {hash: "C", parents: []string{"B"}},
		"D": {hash: "D", parents: []string{"A"}},
		"M": {hash: "M", parents: []string{"C", "D"}},
	}
	if n := countExclusive("D", "C", commits); n != 1 {
		t.Fatalf("commit count = %d, want 1", n)
	}
}

func TestLoadGraphMerge(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	git("checkout", "-b", "feature/login")
	write(t, dir, "login.txt", "ok\n")
	git("add", "login.txt")
	git("commit", "-m", "add login")
	git("checkout", "main")
	git("merge", "--no-ff", "-m", "Merge branch 'feature/login'", "feature/login")

	g, err := LoadGraph(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Merges) != 1 {
		t.Fatalf("merges = %d, want 1: %+v", len(g.Merges), g.Merges)
	}
	m := g.Merges[0]
	if m.SourceBranch != "feature/login" || m.TargetBranch != "main" {
		t.Fatalf("merge %s -> %s", m.SourceBranch, m.TargetBranch)
	}
	if m.CommitCount < 1 {
		t.Fatalf("commit count = %d", m.CommitCount)
	}
	if _, err := time.Parse(time.RFC3339, m.Timestamp); err != nil {
		t.Fatal(err)
	}
}

func TestLoadGraphDeletedBranchKeepsName(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	git("checkout", "-b", "feature/login")
	write(t, dir, "login.txt", "ok\n")
	git("add", "login.txt")
	git("commit", "-m", "add login")
	git("checkout", "main")
	git("merge", "--no-ff", "-m", "Merge branch 'feature/login' of https://github.com/acme/repo", "feature/login")
	git("branch", "-D", "feature/login")

	g, err := LoadGraph(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Merges) != 1 {
		t.Fatalf("merges = %d, want 1: %+v", len(g.Merges), g.Merges)
	}
	if g.Merges[0].SourceBranch != "feature/login" {
		t.Fatalf("source = %q, want feature/login", g.Merges[0].SourceBranch)
	}
	if !contains(g.Branches, "feature/login") {
		t.Fatalf("branches = %v, want feature/login", g.Branches)
	}
}

func TestLoadGraphRemoteTipNamesDeletedBranch(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	git("checkout", "-b", "feature/gone")
	write(t, dir, "gone.txt", "ok\n")
	git("add", "gone.txt")
	git("commit", "-m", "add gone")
	tip := gitOut(t, dir, "rev-parse", "HEAD")
	git("checkout", "main")
	git("update-ref", "refs/remotes/origin/feature/gone", tip)
	git("merge", "--no-ff", "-m", "ship it", "feature/gone")
	git("branch", "-D", "feature/gone")

	g, err := LoadGraph(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(g.Branches, "feature/gone") {
		t.Fatalf("branches = %v, want feature/gone from remote tip", g.Branches)
	}
}

func TestLoadGraphRecreatedBranchKeepsName(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	git("checkout", "-b", "feature")
	write(t, dir, "a.txt", "1\n")
	git("add", "a.txt")
	git("commit", "-m", "a")
	git("checkout", "main")
	git("merge", "--no-ff", "-m", "Merge branch 'feature'", "feature")
	git("branch", "-D", "feature")
	git("checkout", "-b", "feature")
	write(t, dir, "b.txt", "2\n")
	git("add", "b.txt")
	git("commit", "-m", "b")
	git("checkout", "main")
	git("merge", "--no-ff", "-m", "Merge branch 'feature'", "feature")

	g, err := LoadGraph(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Merges) != 2 {
		t.Fatalf("merges = %d, want 2: %+v", len(g.Merges), g.Merges)
	}
	for _, m := range g.Merges {
		if m.SourceBranch != "feature" {
			t.Fatalf("source = %q, want feature", m.SourceBranch)
		}
	}
	n := 0
	for _, b := range g.Branches {
		if b == "feature" || strings.HasPrefix(b, "feature ") {
			n++
		}
	}
	if n != 1 {
		t.Fatalf("feature lanes = %v", g.Branches)
	}
}

func TestLoadGraphRemoteIntoSameBranch(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	git("checkout", "-b", "tmp")
	write(t, dir, "remote.txt", "ok\n")
	git("add", "remote.txt")
	git("commit", "-m", "remote work")
	tip := gitOut(t, dir, "rev-parse", "HEAD")
	git("checkout", "main")
	git("update-ref", "refs/remotes/origin/main", tip)
	git("branch", "-D", "tmp")
	git("merge", "--no-ff", "-m", "Merge remote-tracking branch 'origin/main' into main", "origin/main")

	g, err := LoadGraph(dir)
	if err != nil {
		t.Fatal(err)
	}
	if contains(g.Branches, "origin/main") {
		t.Fatalf("branches = %v, origin/main should stay on main", g.Branches)
	}
	if len(g.Merges) != 1 {
		t.Fatalf("merges = %d, want 1: %+v", len(g.Merges), g.Merges)
	}
	m := g.Merges[0]
	if m.SourceBranch != "main" || m.TargetBranch != "main" {
		t.Fatalf("merge %s -> %s, want main -> main", m.SourceBranch, m.TargetBranch)
	}
	for _, c := range g.Commits {
		if c.Branch == "origin/main" {
			t.Fatalf("commit on origin/main: %+v", c)
		}
		if c.IsMerge && c.Branch != "main" {
			t.Fatalf("merge commit on %q, want main", c.Branch)
		}
	}
}

func TestLoadGraphRemoteMergeStaysOnLocalLane(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	base := gitOut(t, dir, "rev-parse", "HEAD")
	git("checkout", "-b", "tmp")
	write(t, dir, "remote.txt", "ok\n")
	git("add", "remote.txt")
	git("commit", "-m", "remote work")
	git("checkout", "main")
	git("merge", "--no-ff", "-m", "Merge remote-tracking branch 'origin/main' into main", "tmp")
	merge := gitOut(t, dir, "rev-parse", "HEAD")
	git("update-ref", "refs/remotes/origin/main", merge)
	git("branch", "-D", "tmp")
	git("reset", "--hard", base)

	g, err := LoadGraph(dir)
	if err != nil {
		t.Fatal(err)
	}
	if contains(g.Branches, "origin/main") {
		t.Fatalf("branches = %v, origin/main should stay on main", g.Branches)
	}
	if len(g.Merges) != 1 {
		t.Fatalf("merges = %d, want 1: %+v", len(g.Merges), g.Merges)
	}
	m := g.Merges[0]
	if m.SourceBranch != "main" || m.TargetBranch != "main" {
		t.Fatalf("merge %s -> %s, want main -> main", m.SourceBranch, m.TargetBranch)
	}
	for _, c := range g.Commits {
		if c.IsMerge && c.Branch != "main" {
			t.Fatalf("merge commit on %q, want main", c.Branch)
		}
	}
}

func TestLoadGraphCustomMergeKeepsSourceLane(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	git("checkout", "-b", "feature")
	write(t, dir, "feat.txt", "ok\n")
	git("add", "feat.txt")
	git("commit", "-m", "feat work")
	git("checkout", "main")
	git("merge", "--no-ff", "-m", "ship it", "feature")
	git("branch", "-D", "feature")

	g, err := LoadGraph(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Merges) != 1 {
		t.Fatalf("merges = %d, want 1: %+v", len(g.Merges), g.Merges)
	}
	m := g.Merges[0]
	if m.SourceBranch == "" || m.SourceBranch == "main" {
		t.Fatalf("source lane dropped: %+v branches=%v", m, g.Branches)
	}
	if m.TargetBranch != "main" {
		t.Fatalf("target = %q", m.TargetBranch)
	}
	if !contains(g.Branches, m.SourceBranch) {
		t.Fatalf("missing source lane %q in %v", m.SourceBranch, g.Branches)
	}
}

func TestLoadGraphSelectedBranches(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	git("checkout", "-b", "feature/secret")
	write(t, dir, "secret.txt", "nope\n")
	git("add", "secret.txt")
	git("commit", "-m", "secret work")
	git("checkout", "main")

	g, err := loadGraph(dir, []string{"main"})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range g.Commits {
		if c.Subject == "secret work" {
			t.Fatalf("selected main still loaded feature commit: %+v", c)
		}
	}
	if contains(g.Branches, "feature/secret") {
		t.Fatalf("branches = %v, feature/secret should stay unloaded", g.Branches)
	}

	all, err := LoadGraph(dir)
	if err != nil {
		t.Fatal(err)
	}
	if !contains(all.Branches, "feature/secret") {
		t.Fatalf("full load branches = %v, want feature/secret", all.Branches)
	}

	none, err := loadGraph(dir, []string{})
	if err != nil {
		t.Fatal(err)
	}
	if len(none.Commits) != 0 || len(none.Branches) != 0 {
		t.Fatalf("empty selection still loaded %+v", none)
	}
}

func TestLoadGraphHidesMergedBranch(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	git("checkout", "-b", "feature/login")
	write(t, dir, "login.txt", "ok\n")
	git("add", "login.txt")
	git("commit", "-m", "add login")
	git("checkout", "main")
	git("merge", "--no-ff", "-m", "Merge branch 'feature/login'", "feature/login")

	g, err := loadGraph(dir, []string{"main"})
	if err != nil {
		t.Fatal(err)
	}
	if contains(g.Branches, "feature/login") {
		t.Fatalf("branches = %v, hidden feature/login should stay unloaded", g.Branches)
	}
	for _, c := range g.Commits {
		if c.Subject == "add login" {
			t.Fatalf("hidden branch commit still loaded: %+v", c)
		}
	}
	if len(g.Merges) != 1 || g.Merges[0].TargetBranch != "main" {
		t.Fatalf("merges = %+v", g.Merges)
	}
}

func TestListBranches(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	git("checkout", "-b", "feature/login")
	write(t, dir, "login.txt", "ok\n")
	git("add", "login.txt")
	git("commit", "-m", "add login")

	got, err := ListBranches(dir)
	if err != nil {
		t.Fatal(err)
	}
	names := make([]string, 0, len(got))
	for _, b := range got {
		names = append(names, b.Name)
		if b.Updated == "" {
			t.Fatalf("%s missing updated", b.Name)
		}
	}
	if !contains(names, "main") || !contains(names, "feature/login") {
		t.Fatalf("branches = %v", names)
	}
}

func testRepo(t *testing.T) (string, func(...string)) {
	t.Helper()
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("git not on PATH")
	}
	dir := t.TempDir()
	git := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(),
			"GIT_AUTHOR_NAME=Test",
			"GIT_AUTHOR_EMAIL=test@example.com",
			"GIT_COMMITTER_NAME=Test",
			"GIT_COMMITTER_EMAIL=test@example.com",
		)
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	git("init", "-b", "main")
	git("config", "user.name", "Test")
	git("config", "user.email", "test@example.com")
	return dir, git
}

func gitOut(t *testing.T, dir string, args ...string) string {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	out, err := cmd.Output()
	if err != nil {
		t.Fatalf("git %v: %v", args, err)
	}
	return strings.TrimSpace(string(out))
}

func contains(xs []string, want string) bool {
	for _, x := range xs {
		if x == want {
			return true
		}
	}
	return false
}

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
}
