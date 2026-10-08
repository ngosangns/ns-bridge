// Command ns-bridge is the Go sidecar the ns-bridge host adapters start for
// vendor calls. The protocol is specified in docs/SIDECAR-PROTOCOL.md.
//
//	ns-bridge stream --vendor <id>   one model call: request envelope on stdin, NDJSON events on stdout
//	ns-bridge call --vendor <id> --op <op>  one operation (catalog, usage, token refresh): one result line
//	ns-bridge vendors                list vendor ids this binary serves
//	ns-bridge version                print the binary and protocol versions
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/ngosangns/ns-bridge/go/internal/bridge"
	"github.com/ngosangns/ns-bridge/go/internal/sidecar"
	"github.com/ngosangns/ns-bridge/go/internal/vendors/devin"
	"github.com/ngosangns/ns-bridge/go/internal/vendors/echo"
	"github.com/ngosangns/ns-bridge/go/internal/vendors/kiro"
)

// version is stamped at release with -ldflags "-X main.version=<v>".
var version = "dev"

// Exit code for a command-line mistake; protocol-level failures use the
// terminal error line and sidecar.ExitError instead.
const exitUsage = 2

func registry() sidecar.Registry {
	return sidecar.Registry{
		"devin": devin.Vendor{},
		"echo":  echo.Vendor{},
		"kiro":  kiro.Vendor{},
	}
}

func main() {
	os.Exit(run(os.Args[1:], os.Stdin, os.Stdout, os.Stderr))
}

func run(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	if len(args) == 0 {
		usage(stderr)
		return exitUsage
	}
	switch args[0] {
	case "stream":
		return stream(args[1:], stdin, stdout, stderr)
	case "call":
		return call(args[1:], stdin, stdout, stderr)
	case "vendors":
		fmt.Fprintln(stdout, strings.Join(registry().IDs(), "\n"))
		return 0
	case "version", "--version", "-v":
		fmt.Fprintf(stdout, "ns-bridge %s (protocol %d)\n", version, bridge.ProtocolVersion)
		return 0
	case "help", "--help", "-h":
		usage(stdout)
		return 0
	default:
		fmt.Fprintf(stderr, "ns-bridge: unknown command %q\n", args[0])
		usage(stderr)
		return exitUsage
	}
}

func stream(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("stream", flag.ContinueOnError)
	flags.SetOutput(stderr)
	vendor := flags.String("vendor", "", "vendor id (see `ns-bridge vendors`)")
	ignoreEOF := flags.Bool("ignore-stdin-eof", false, "keep running after stdin closes (for requests piped in by hand)")
	if err := flags.Parse(args); err != nil {
		return exitUsage
	}
	if *vendor == "" {
		fmt.Fprintln(stderr, "ns-bridge stream: --vendor is required")
		return exitUsage
	}

	// SIGTERM is the host's second cancellation step (after closing stdin).
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	return sidecar.Run(ctx, *vendor, registry(), sidecar.Options{IgnoreStdinEOF: *ignoreEOF}, stdin, stdout)
}

func call(args []string, stdin io.Reader, stdout, stderr io.Writer) int {
	flags := flag.NewFlagSet("call", flag.ContinueOnError)
	flags.SetOutput(stderr)
	vendor := flags.String("vendor", "", "vendor id (see `ns-bridge vendors`)")
	op := flags.String("op", "", "operation, e.g. refreshModels, usage, refreshToken")
	if err := flags.Parse(args); err != nil {
		return exitUsage
	}
	if *vendor == "" || *op == "" {
		fmt.Fprintln(stderr, "ns-bridge call: --vendor and --op are required")
		return exitUsage
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, os.Interrupt)
	defer stop()
	return sidecar.RunCall(ctx, *vendor, *op, registry(), stdin, stdout)
}

func usage(w io.Writer) {
	fmt.Fprint(w, `usage:
  ns-bridge stream --vendor <id> [--ignore-stdin-eof]
      Read {"protocol":1,"request":{...}} on stdin, write BridgeStreamEvent NDJSON on stdout.
  ns-bridge call --vendor <id> --op <op>
      Read {"protocol":1,"request":{...}} on stdin, write one {"type":"result","result":...} line.
  ns-bridge vendors
  ns-bridge version
`)
}
