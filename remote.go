package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

type RemoteInfo struct {
	Name     string `json:"name"`
	URL      string `json:"url"`
	Web      string `json:"web,omitempty"`
	Host     string `json:"host,omitempty"`
	HasToken bool   `json:"hasToken"`
	SSH      bool   `json:"ssh"`
}

type authFile struct {
	Tokens map[string]string `json:"tokens"`
}

var authDir string

func listRemote(root string) (RemoteInfo, error) {
	name := "origin"
	u, err := gitOutput(root, "remote", "get-url", "origin")
	if err != nil || u == "" {
		names, e := gitOutput(root, "remote")
		if e != nil || names == "" {
			return RemoteInfo{}, fmt.Errorf("no git remotes")
		}
		name = strings.Fields(names)[0]
		u, err = gitOutput(root, "remote", "get-url", name)
		if err != nil || u == "" {
			return RemoteInfo{}, fmt.Errorf("no git remotes")
		}
	}
	web := toWebBase(u)
	info := RemoteInfo{Name: name, URL: u, Web: web, Host: remoteHost(web), SSH: isSSHURL(u)}
	tokens, _ := loadTokens()
	info.HasToken = info.Host != "" && tokens[info.Host] != ""
	return info, nil
}

func fetchRemote(root string, info RemoteInfo, token string) error {
	args := fetchArgs(info.Name, info.URL, token)
	_, err := gitRun(root, 60*time.Second, args...)
	return err
}

func fetchArgs(remoteName, url, token string) []string {
	args := []string{"fetch", "--prune", remoteName}
	if token == "" || isSSHURL(url) {
		return args
	}
	user := tokenUser(remoteHost(toWebBase(url)))
	auth := base64.StdEncoding.EncodeToString([]byte(user + ":" + token))
	return []string{"-c", "credential.helper=", "-c", "http.extraHeader=Authorization: Basic " + auth, "fetch", "--prune", remoteName}
}

func tokenUser(host string) string {
	h := strings.ToLower(host)
	if strings.Contains(h, "gitlab") {
		return "oauth2"
	}
	if strings.Contains(h, "bitbucket") {
		return "x-token-auth"
	}
	return "x-access-token"
}

func remoteHost(web string) string {
	if _, rest, ok := strings.Cut(web, "://"); ok {
		host, _, _ := strings.Cut(rest, "/")
		return host
	}
	return ""
}

func isSSHURL(u string) bool {
	u = strings.TrimSpace(u)
	return strings.HasPrefix(u, "git@") || strings.HasPrefix(u, "ssh://")
}

func authPath() (string, error) {
	dir, err := configDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(dir, "auth.json"), nil
}

func loadTokens() (map[string]string, error) {
	p, err := authPath()
	if err != nil {
		return map[string]string{}, err
	}
	b, err := os.ReadFile(p)
	if err != nil {
		if os.IsNotExist(err) {
			return map[string]string{}, nil
		}
		return map[string]string{}, err
	}
	var f authFile
	if err := json.Unmarshal(b, &f); err != nil {
		return map[string]string{}, err
	}
	if f.Tokens == nil {
		f.Tokens = map[string]string{}
	}
	return f.Tokens, nil
}

func saveToken(host, token string) error {
	host = strings.TrimSpace(host)
	if host == "" {
		return fmt.Errorf("no remote host")
	}
	tokens, err := loadTokens()
	if err != nil {
		return err
	}
	token = strings.TrimSpace(token)
	if token == "" {
		delete(tokens, host)
	} else {
		tokens[host] = token
	}
	p, err := authPath()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(p), 0o700); err != nil {
		return err
	}
	b, err := json.MarshalIndent(authFile{Tokens: tokens}, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(p, b, 0o600)
}

func gitRun(dir string, timeout time.Duration, args ...string) (string, error) {
	ctx := context.Background()
	if timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, timeout)
		defer cancel()
	}
	cmd := exec.CommandContext(ctx, "git", append([]string{"-C", dir}, args...)...)
	hideWindow(cmd)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		msg := strings.TrimSpace(stderr.String())
		if ctx.Err() == context.DeadlineExceeded {
			return "", fmt.Errorf("fetch timed out")
		}
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("%s", msg)
	}
	return strings.TrimSpace(string(out)), nil
}
