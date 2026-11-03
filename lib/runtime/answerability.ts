/**
 * Answerability for how-to questions (docs/pilot-conversations-fixes.md, fix 3).
 *
 * Retrieval can only find sources that mention a topic. A newsletter that announces a training, a summary that names a process, or a
 * page that says "the details are in the Wiki" mentions the process without containing it; found in production, where "What are the
 * steps of the client onboarding process?" for the US was answered by describing the announcement of a training. When the user asks
 * for steps, a source counts as an answer only if it contains them. The model makes that judgment from the text (a sequence of
 * actions, stages, requirements or rules the user can follow), in any language and in any source type, so a newsletter or a training
 * transcript that does contain the steps still answers.
 */
export const ANSWERABILITY_NOTICE =
  `[Answerability notice] The user is asking for steps, a process or instructions. Before answering, decide whether any source above actually CONTAINS them: a sequence of actions, stages, meetings, requirements or rules the user can follow. ` +
  `A source that announces a training or update, names or summarizes a process, or points to a document, page or course that is not itself shown above is a reference, not instructions, even when it is about exactly this topic. ` +
  `A source that lists the stages or actions, in any language and in any format (a training transcript, an overview, a table), is instructions. ` +
  `If the sources contain the instructions, give them and do not hedge about steps that you can see. ` +
  `If they do not, begin your answer with one plain sentence saying that the steps are not in the approved knowledge, then say only what the sources do establish (for example that a training exists, who it is for and where to find it) and stop: do not describe the process from an announcement as if it were the process, and do not invent steps. ` +
  `If only part of the process is shown, give that part and say which part is missing.`;
