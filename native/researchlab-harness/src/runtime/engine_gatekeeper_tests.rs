    #[test]
    fn gatekeeper_empty_output_flips_to_failed() {
        // exit-0 response with no verdict and empty last-message → failed
        assert!(is_gatekeeper_empty_output(
            "gatekeeper",
            "completed",
            None,
            ""
        ));
    }

    #[test]
    fn gatekeeper_empty_output_ignores_whitespace() {
        // trimmed whitespace-only message still counts as empty
        assert!(is_gatekeeper_empty_output(
            "gatekeeper",
            "completed",
            None,
            "   \n \t"
        ));
    }

    #[test]
    fn gatekeeper_with_valid_verdict_stays_completed() {
        let ex = json!({ "verdict": "approve", "summary": "ok" });
        assert!(!is_gatekeeper_empty_output(
            "gatekeeper",
            "completed",
            Some(&ex),
            ""
        ));
    }

    #[test]
    fn gatekeeper_with_message_body_stays_completed() {
        // If the last-message has text (even without a parseable verdict)
        // we defer to the aggregator's partial-parse path instead of
        // reclassifying as failed.
        assert!(!is_gatekeeper_empty_output(
            "gatekeeper",
            "completed",
            None,
            "I reviewed the brief and concluded X because Y."
        ));
    }

    #[test]
    fn non_gatekeeper_role_is_never_reclassified() {
        // Only the gatekeeper path flips; analyst/runner/chronicle are
        // handled by their own branches in run_codex_agent_lane.
        assert!(!is_gatekeeper_empty_output(
            "analyst",
            "completed",
            None,
            ""
        ));
        assert!(!is_gatekeeper_empty_output(
            "chronicle",
            "completed",
            None,
            ""
        ));
        assert!(!is_gatekeeper_empty_output("author", "completed", None, ""));
    }

    #[test]
    fn already_failed_status_is_not_double_flipped() {
        // If some earlier path already set status=failed we must leave it
        // alone — otherwise the recovery helpers skip over it.
        assert!(!is_gatekeeper_empty_output(
            "gatekeeper",
            "failed",
            None,
            ""
        ));
    }

    #[test]
    fn gatekeeper_empty_verdict_string_is_empty_output() {
        // verdict="" in extracted_json is not a real verdict; treat as empty
        let ex = json!({ "verdict": "   " });
        assert!(is_gatekeeper_empty_output(
            "gatekeeper",
            "completed",
            Some(&ex),
            ""
        ));
    }
