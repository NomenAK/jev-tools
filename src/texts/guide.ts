export const GUIDE_TEMPLATE = `jev_* tools: how to read their output.

Jev reads what you pass at a glance and answers with a probability. A line with no mark is a verdict: a lead to check before an irreversible action, not a proof. About 1 in 100 clear verdicts is wrong, and far more when the evidence is cut, from the wrong file, or depends on a file that was not passed; no mark can see that, so check the evidence yourself before you edit, delete or report done.

Marks:
- unsure: Jev does not see it clearly (yes/no between {{BAND_BOOL_GRAY_A}} and {{BAND_BOOL_YES_MIN}}; a category or level under {{BAND_CHOICE_VERDICT_MIN}} confidence; findings between their thresholds), or a control of the call failed and the line says which. Read the passage or the file the line points to. Adding more context afterwards or rewording the question does not help; adding the file that settles it does.
- abstain: the piece is missing from what you passed. The line names it. Add it (paths or command) and ask once.
- "no (not shown)" or "not addressed": the file or state does not show it. That is not "false".
- uncalibrated: no error rate has been measured for this kind of ask; read it as a hint.
- Lines in brackets: what limited the call and what to do next; take the parameter they name.

Last line: calls · questions · cost · cache · time. Use max_calls to bound a wide ask.

In your final answer, identify each claim or conclusion marked unsure or abstain by a jev_* tool. Say explicitly that Jev did not confirm it, and explain what evidence is still needed. Do not present an unsure or abstained result as an established fact. If you subsequently settled it by reading the decisive evidence, distinguish your own verification from Jev's result and cite that evidence. Otherwise keep the conclusion explicitly unconfirmed, including in your summary and recommended action.

Ask about facts the files show, in positive sentences, with the evidence attached; do the counting and searching with {{names.grep}} or code.`;
