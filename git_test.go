package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestCommitURLPrefix(t *testing.T) {
	cases := []struct{ remote, hash, want string }{
		{"git@github.com:acme/repo.git", "abc", "https://github.com/acme/repo/commit/abc"},
		{"https://github.com/acme/repo.git", "abc", "https://github.com/acme/repo/commit/abc"},
		{"https://user:token@github.com/acme/repo.git", "abc", "https://github.com/acme/repo/commit/abc"},
		{"https://gitlab.com/acme/repo.git", "abc", "https://gitlab.com/acme/repo/-/commit/abc"},
		{"git@bitbucket.org:acme/repo.git", "abc", "https://bitbucket.org/acme/repo/commits/abc"},
		{"", "abc", ""},
	}
	for _, c := range cases {
		p := commitURLPrefix(toWebBase(c.remote))
		got := p
		if p != "" {
			got = p + c.hash
		}
		if got != c.want {
			t.Fatalf("%q: got %q want %q", c.remote, got, c.want)
		}
	}
}

func TestLoadGraphCommitURL(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	git("remote", "add", "origin", "git@github.com:acme/repo.git")
	g, err := LoadGraph(dir)
	if err != nil {
		t.Fatal(err)
	}
	if g.CommitURL != "https://github.com/acme/repo/commit/" {
		t.Fatalf("commitUrl = %q", g.CommitURL)
	}
}

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
		{"Merge branch 'refs/heads/dev' into epic/TR-2369-rework", "dev", "epic/TR-2369-rework"},
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
	git("checkout", "main")
	git("merge", "--no-ff", "-m", "Merge branch 'main' of origin into main", "tmp")
	git("branch", "-D", "tmp")
	git("checkout", "-b", "TR-2546")
	write(t, dir, "feat.txt", "ok\n")
	git("add", "feat.txt")
	git("commit", "-m", "ticket work")
	git("checkout", "main")
	write(t, dir, "later.txt", "x\n")
	git("add", "later.txt")
	git("commit", "-m", "main later")

	g, err := loadGraph(dir, []string{"main", "TR-2546"})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range g.Commits {
		if strings.Contains(c.Subject, "into main") {
			found = true
			if c.Branch != "main" {
				t.Fatalf("remote-into-local merge on %q, want main", c.Branch)
			}
		}
	}
	if !found {
		t.Fatalf("missing same-lane merge: %+v", subjects(g))
	}
	for _, m := range g.Merges {
		if strings.Contains(m.Subject, "into main") && (m.SourceBranch != "main" || m.TargetBranch != "main") {
			t.Fatalf("merge %s -> %s, want main -> main", m.SourceBranch, m.TargetBranch)
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
	if !contains(g.Branches, "feature/login") {
		t.Fatalf("branches = %v, want feature/login comet lane", g.Branches)
	}
	for _, c := range g.Commits {
		if c.Subject == "add login" {
			t.Fatalf("hidden branch commit still loaded: %+v", c)
		}
	}
	if len(g.Merges) != 1 || g.Merges[0].TargetBranch != "main" || g.Merges[0].SourceBranch != "feature/login" {
		t.Fatalf("merges = %+v", g.Merges)
	}
}

func TestLoadGraphOffSpineMergeIntoLane(t *testing.T) {
	for _, want := range []string{
		"Merge branch 'refs/heads/feature' into main",
		"Merged in feature (pull request #114)",
	} {
		t.Run(want, func(t *testing.T) {
			dir, git := testRepo(t)
			write(t, dir, "README.md", "a\n")
			git("add", "README.md")
			git("commit", "-m", "init")
			base := gitOut(t, dir, "rev-parse", "HEAD")
			git("checkout", "-b", "feature")
			write(t, dir, "feat.txt", "ok\n")
			git("add", "feat.txt")
			git("commit", "-m", "feat")
			git("checkout", "main")
			git("merge", "--no-ff", "-m", want, "feature")
			git("branch", "-D", "feature")
			git("checkout", "-b", "bob", base)
			write(t, dir, "bob.txt", "b\n")
			git("add", "bob.txt")
			git("commit", "-m", "bob")
			git("merge", "--no-ff", "-m", "Merge branch 'main' of origin into main", "main")
			git("checkout", "main")
			git("reset", "--hard", "bob")
			git("branch", "-D", "bob")

			since := time.Now().UTC().Add(-24 * time.Hour)
			until := time.Now().UTC().Add(time.Hour)
			g, err := loadGraphAt(dir, []string{"main"}, since, until)
			if err != nil {
				t.Fatal(err)
			}
			if !hasSubject(g, want) {
				t.Fatalf("missing off-spine merge: %+v", subjects(g))
			}
			if hasSubject(g, "feat") {
				t.Fatalf("source branch commits landed on main: %+v", subjects(g))
			}
			for _, c := range g.Commits {
				if c.Branch != "main" {
					t.Fatalf("commit %q on %q, want main", c.Subject, c.Branch)
				}
			}
			found := false
			for _, m := range g.Merges {
				if m.SourceBranch == "feature" && m.TargetBranch == "main" && m.Subject == want {
					found = true
				}
			}
			if !found {
				t.Fatalf("merges = %+v", g.Merges)
			}
		})
	}
}

func TestLoadGraphMergeFromTrunkIntoFeature(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	git("checkout", "-b", "TR-2546")
	write(t, dir, "feat.txt", "ok\n")
	git("add", "feat.txt")
	git("commit", "-m", "ticket work")
	git("checkout", "main")
	write(t, dir, "dev.txt", "d\n")
	git("add", "dev.txt")
	git("commit", "-m", "dev only")
	git("checkout", "TR-2546")
	git("merge", "--no-ff", "-m", "Merge branch 'refs/heads/main' into epic/TR-2369-rework", "main")

	g, err := loadGraph(dir, []string{"main", "TR-2546"})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, m := range g.Merges {
		if strings.Contains(m.Subject, "refs/heads/main") {
			found = true
			if m.SourceBranch != "main" {
				t.Fatalf("source = %q, want main (from message)", m.SourceBranch)
			}
			if m.TargetBranch != "TR-2546" {
				t.Fatalf("target = %q, want TR-2546 (displayed lane), not epic", m.TargetBranch)
			}
		}
	}
	if !found {
		t.Fatalf("missing merge from dev: %+v", g.Merges)
	}
	for _, c := range g.Commits {
		if c.IsMerge && strings.Contains(c.Subject, "refs/heads/main") && c.Branch != "TR-2546" {
			t.Fatalf("merge commit on %q, want TR-2546", c.Branch)
		}
	}
}

func TestLoadGraphMergedInShowsOnReceiver(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	git("checkout", "-b", "TR-2546")
	write(t, dir, "feat.txt", "ok\n")
	git("add", "feat.txt")
	git("commit", "-m", "ticket work")
	git("checkout", "main")
	git("merge", "--no-ff", "-m", "Merged in TR-2546 (pull request #9)", "TR-2546")

	g, err := loadGraph(dir, []string{"main", "TR-2546"})
	if err != nil {
		t.Fatal(err)
	}
	for _, c := range g.Commits {
		if strings.Contains(c.Subject, "Merged in TR-2546") && c.Branch != "main" {
			t.Fatalf("Merged in commit on %q, want main (receiver), not source", c.Branch)
		}
	}
	found := false
	for _, m := range g.Merges {
		if strings.Contains(m.Subject, "Merged in TR-2546") {
			found = true
			if m.SourceBranch != "TR-2546" || m.TargetBranch != "main" {
				t.Fatalf("merge %s -> %s, want TR-2546 -> main", m.SourceBranch, m.TargetBranch)
			}
		}
	}
	if !found {
		t.Fatalf("missing Merged in event: %+v", g.Merges)
	}
}

func TestLoadGraphRemoteIntoFeatureStaysOnFeature(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	git("checkout", "-b", "TR-2546")
	write(t, dir, "feat.txt", "ok\n")
	git("add", "feat.txt")
	git("commit", "-m", "ticket work")
	git("checkout", "main")
	write(t, dir, "dev.txt", "d\n")
	git("add", "dev.txt")
	git("commit", "-m", "dev only")
	git("checkout", "TR-2546")
	git("merge", "--no-ff", "-m", "Merge remote-tracking branch 'origin/main' into TR-2546", "main")

	g, err := loadGraph(dir, []string{"main", "TR-2546"})
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, c := range g.Commits {
		if strings.Contains(c.Subject, "origin/main") {
			found = true
			if c.Branch != "TR-2546" {
				t.Fatalf("remote-into-feature merge on %q, want TR-2546", c.Branch)
			}
		}
	}
	if !found {
		t.Fatalf("missing remote-into-feature merge: %+v", subjects(g))
	}
	for _, m := range g.Merges {
		if strings.Contains(m.Subject, "origin/main") {
			if m.SourceBranch != "main" || m.TargetBranch != "TR-2546" {
				t.Fatalf("merge %s -> %s, want main -> TR-2546", m.SourceBranch, m.TargetBranch)
			}
		}
	}
}

func TestLoadGraphFeatureKeepsCommitsWhenTrunkAdded(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	git("checkout", "-b", "TR-2546")
	write(t, dir, "feat.txt", "ok\n")
	git("add", "feat.txt")
	git("commit", "-m", "ticket work")
	git("checkout", "main")
	write(t, dir, "dev.txt", "d\n")
	git("add", "dev.txt")
	git("commit", "-m", "dev only")

	onlyFeat, err := loadGraph(dir, []string{"TR-2546"})
	if err != nil {
		t.Fatal(err)
	}
	byFeat := map[string]string{}
	for _, c := range onlyFeat.Commits {
		byFeat[c.Subject] = c.Branch
	}
	if byFeat["ticket work"] != "TR-2546" {
		t.Fatalf("feature-only ticket work on %q want TR-2546: %+v", byFeat["ticket work"], subjects(onlyFeat))
	}
	if hasSubject(onlyFeat, "dev only") {
		t.Fatalf("feature-only should not contain dev only (exclusive): %+v", subjects(onlyFeat))
	}
	if byFeat["init"] == "TR-2546" {
		t.Fatalf("feature-only shared init should not be on TR-2546 when main hidden (exclusive), got %q", byFeat["init"])
	}

	both, err := loadGraph(dir, []string{"main", "TR-2546"})
	if err != nil {
		t.Fatal(err)
	}
	bySubj := map[string]string{}
	for _, c := range both.Commits {
		bySubj[c.Subject] = c.Branch
	}
	if bySubj["ticket work"] != "TR-2546" {
		t.Fatalf("ticket work on %q, want TR-2546; lanes=%v", bySubj["ticket work"], bySubj)
	}
	if bySubj["init"] != "main" {
		t.Fatalf("shared init on %q want main (original trunk), got %q", bySubj["init"], bySubj["init"])
	}
	if bySubj["dev only"] != "main" {
		t.Fatalf("dev only on %q, want main", bySubj["dev only"])
	}

	since := time.Now().UTC().Add(-24 * time.Hour)
	until := time.Now().UTC().Add(time.Hour)
	windowed, err := loadGraphAt(dir, []string{"main", "TR-2546"}, since, until)
	if err != nil {
		t.Fatal(err)
	}
	bySubj = map[string]string{}
	for _, c := range windowed.Commits {
		bySubj[c.Subject] = c.Branch
	}
	if bySubj["ticket work"] != "TR-2546" {
		t.Fatalf("windowed ticket work on %q", bySubj["ticket work"])
	}
	if bySubj["init"] != "main" {
		t.Fatalf("windowed shared init on %q want main", bySubj["init"])
	}
	if bySubj["dev only"] != "main" {
		t.Fatalf("windowed dev only on %q", bySubj["dev only"])
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

func TestListBranchesSortedByUpdated(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	commitAt(t, dir, time.Date(2024, 1, 1, 12, 0, 0, 0, time.UTC), "init")

	git("checkout", "-b", "feature/old")
	write(t, dir, "old.txt", "x\n")
	git("add", "old.txt")
	commitAt(t, dir, time.Date(2024, 6, 1, 12, 0, 0, 0, time.UTC), "old")

	git("checkout", "-b", "zzz-newest")
	write(t, dir, "new.txt", "y\n")
	git("add", "new.txt")
	commitAt(t, dir, time.Date(2025, 1, 1, 12, 0, 0, 0, time.UTC), "new")

	git("checkout", "-b", "rebased-stale")
	write(t, dir, "rebase.txt", "z\n")
	git("add", "rebase.txt")
	commitAtSplit(t, dir, time.Date(2020, 1, 1, 12, 0, 0, 0, time.UTC), time.Date(2026, 6, 1, 12, 0, 0, 0, time.UTC), "rebased")

	got, err := ListBranches(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) < 4 || got[0].Name != "rebased-stale" {
		t.Fatalf("order = %v, want rebased-stale first (newest committer date)", namesOf(got))
	}
}

func namesOf(list []BranchInfo) []string {
	out := make([]string, 0, len(list))
	for _, b := range list {
		out = append(out, b.Name)
	}
	return out
}

func TestLoadGraphTags(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	git("tag", "v1.0")
	git("tag", "-a", "release", "-m", "annotated")
	write(t, dir, "x.txt", "b\n")
	git("add", "x.txt")
	git("commit", "-m", "second")
	git("tag", "v2.0")

	g, err := LoadGraph(dir)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string][]string{}
	for _, c := range g.Commits {
		if len(c.Tags) > 0 {
			got[c.Subject] = c.Tags
		}
	}
	if strings.Join(got["init"], ",") != "release,v1.0" {
		t.Fatalf("init tags = %v, want [release v1.0]", got["init"])
	}
	if strings.Join(got["second"], ",") != "v2.0" {
		t.Fatalf("second tags = %v, want [v2.0]", got["second"])
	}
}

func TestLoadGraphTimeRange(t *testing.T) {
	dir, git := testRepo(t)
	old := time.Date(2024, 1, 15, 12, 0, 0, 0, time.UTC)
	recent := time.Now().UTC().AddDate(0, -1, 0)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	commitAt(t, dir, old, "old work")
	write(t, dir, "new.txt", "b\n")
	git("add", "new.txt")
	commitAt(t, dir, recent, "new work")

	since := time.Now().UTC().AddDate(0, -3, 0)
	until := time.Now().UTC().Add(time.Hour)
	g, err := loadGraphAt(dir, []string{"main"}, since, until)
	if err != nil {
		t.Fatal(err)
	}
	if !hasSubject(g, "new work") {
		t.Fatalf("recent window missing new work: %+v", subjects(g))
	}
	if hasSubject(g, "old work") {
		t.Fatalf("recent window loaded old work: %+v", subjects(g))
	}

	older, err := loadGraphAt(dir, []string{"main"}, old.Add(-24*time.Hour), since)
	if err != nil {
		t.Fatal(err)
	}
	if !hasSubject(older, "old work") {
		t.Fatalf("older window missing old work: %+v", subjects(older))
	}
	if hasSubject(older, "new work") {
		t.Fatalf("older window loaded new work: %+v", subjects(older))
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

func commitAt(t *testing.T, dir string, at time.Time, msg string) {
	commitAtSplit(t, dir, at, at, msg)
}

func commitAtSplit(t *testing.T, dir string, author, committer time.Time, msg string) {
	t.Helper()
	cmd := exec.Command("git", "commit", "-m", msg)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(),
		"GIT_AUTHOR_NAME=Test",
		"GIT_AUTHOR_EMAIL=test@example.com",
		"GIT_COMMITTER_NAME=Test",
		"GIT_COMMITTER_EMAIL=test@example.com",
		"GIT_AUTHOR_DATE="+author.Format(time.RFC3339),
		"GIT_COMMITTER_DATE="+committer.Format(time.RFC3339),
	)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git commit: %v\n%s", err, out)
	}
}

func subjects(g *RepoGraph) []string {
	out := make([]string, 0, len(g.Commits))
	for _, c := range g.Commits {
		out = append(out, c.Subject)
	}
	return out
}

func hasSubject(g *RepoGraph, want string) bool {
	return contains(subjects(g), want)
}

func TestCommitDiff(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "base.txt", "base\n")
	git("add", "base.txt")
	git("commit", "-m", "base")

	write(t, dir, "a.txt", "one\n")
	git("add", "a.txt")
	git("commit", "-m", "add a")
	hash := gitOut(t, dir, "rev-parse", "HEAD")

	// Default: unified diff of the commit against its parent.
	out, err := commitDiff(dir, commitDiffInput{Hash: hash})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(out, "+one") {
		t.Fatalf("diff missing added line:\n%s", out)
	}

	// Stat-only returns the file summary without the patch body.
	stat, err := commitDiff(dir, commitDiffInput{Hash: hash, Stat: true})
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(stat, "a.txt") || strings.Contains(stat, "+one") {
		t.Fatalf("stat should list a.txt without the patch body:\n%s", stat)
	}

	// Path filtering limits the diff to the requested file.
	write(t, dir, "b.txt", "x\n")
	git("add", "b.txt")
	git("commit", "-m", "add b")
	hash2 := gitOut(t, dir, "rev-parse", "HEAD")
	onlyB, err := commitDiff(dir, commitDiffInput{Hash: hash2, Path: "b.txt"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(onlyB, "a.txt") {
		t.Fatalf("path filter leaked other files:\n%s", onlyB)
	}

	// Merge commits: parents are ordered and each is addressable.
	git("checkout", "-b", "feature")
	write(t, dir, "f.txt", "feat\n")
	git("add", "f.txt")
	git("commit", "-m", "feature work")
	git("checkout", "main")
	git("merge", "--no-ff", "-m", "Merge branch 'feature'", "feature")
	hash3 := gitOut(t, dir, "rev-parse", "HEAD")
	parents, err := parentsOf(dir, hash3)
	if err != nil {
		t.Fatal(err)
	}
	if len(parents) != 2 {
		t.Fatalf("merge has %d parents, want 2", len(parents))
	}
	for _, against := range []string{"1", "2"} {
		if _, err := commitDiff(dir, commitDiffInput{Hash: hash3, Against: against}); err != nil {
			t.Fatalf("against %s: %v", against, err)
		}
	}
	if _, err := commitDiff(dir, commitDiffInput{Hash: hash3, Against: "4"}); err == nil {
		t.Fatal("expected error for out-of-range parent index")
	}

	// Invalid references are rejected up front.
	if _, err := commitDiff(dir, commitDiffInput{Hash: "nonsense!!"}); err == nil {
		t.Fatal("expected error for invalid hash")
	}
	if _, err := parentsOf(dir, "deadbeef"); err == nil {
		t.Fatal("expected error for unknown revision")
	}
}
