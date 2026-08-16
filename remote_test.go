package main

import (
	"strings"
	"testing"
)

func TestListRemote(t *testing.T) {
	dir, git := testRepo(t)
	write(t, dir, "README.md", "a\n")
	git("add", "README.md")
	git("commit", "-m", "init")
	if _, err := listRemote(dir); err == nil {
		t.Fatal("expected no remotes")
	}
	git("remote", "add", "origin", "git@github.com:acme/repo.git")
	info, err := listRemote(dir)
	if err != nil {
		t.Fatal(err)
	}
	if info.Name != "origin" || !info.SSH || info.Host != "github.com" || info.Web != "https://github.com/acme/repo" {
		t.Fatalf("%+v", info)
	}
}

func TestFetchArgs(t *testing.T) {
	ssh := fetchArgs("origin", "git@github.com:acme/repo.git", "tok")
	if strings.Join(ssh, " ") != "fetch --prune origin" {
		t.Fatalf("ssh args = %v", ssh)
	}
	https := fetchArgs("origin", "https://github.com/acme/repo.git", "tok")
	if len(https) < 4 || https[len(https)-1] != "origin" || !strings.Contains(https[3], "Authorization: Basic") {
		t.Fatalf("https args = %v", https)
	}
}

func TestSaveToken(t *testing.T) {
	prev := authDir
	authDir = t.TempDir()
	t.Cleanup(func() { authDir = prev })

	if err := saveToken("github.com", "ghp_test"); err != nil {
		t.Fatal(err)
	}
	tokens, err := loadTokens()
	if err != nil || tokens["github.com"] != "ghp_test" {
		t.Fatalf("tokens = %v err = %v", tokens, err)
	}
	if err := saveToken("github.com", ""); err != nil {
		t.Fatal(err)
	}
	tokens, err = loadTokens()
	if err != nil || tokens["github.com"] != "" {
		t.Fatalf("cleared = %v", tokens)
	}
}

func TestTokenUser(t *testing.T) {
	if tokenUser("github.com") != "x-access-token" {
		t.Fatal(tokenUser("github.com"))
	}
	if tokenUser("gitlab.com") != "oauth2" {
		t.Fatal(tokenUser("gitlab.com"))
	}
	if tokenUser("bitbucket.org") != "x-token-auth" {
		t.Fatal(tokenUser("bitbucket.org"))
	}
}
