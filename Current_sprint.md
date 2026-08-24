# CURRENT_SPRINT.md

# Sprint Goal

Build the first functional prototype of Hubi.

This prototype is intended to validate the product vision with executive stakeholders before production development begins.

The objective is not feature completeness.

The objective is to demonstrate that Hubi can become Revenue's AI Copilot by delivering an exceptional conversational experience grounded in trusted organizational knowledge.

Every implementation decision during this sprint should prioritize product quality, architectural clarity and demonstration value.

---

# Success Criteria

The prototype is successful if a first-time user immediately understands:

- what Hubi is;
- how it differs from searching documentation;
- how it supports real Revenue work;
- why it creates value beyond a traditional chatbot.

The prototype should feel like an early version of a production product rather than a proof of concept.

---

# User Experience

This sprint delivers one single product experience:

**Conversational AI Copilot**

Conversation is the primary interface.

Every interaction should help users accomplish work rather than simply retrieve information.

---

# User Journey

The expected interaction is:

1. User opens Hubi.
2. User describes a question or business situation.
3. Hubi understands the user's intent.
4. Hubi determines whether additional context is required.
5. Hubi asks follow-up questions when necessary.
6. Hubi retrieves relevant knowledge.
7. Hubi builds a grounded prompt.
8. Hubi invokes the Reasoning Engine.
9. Hubi renders the response.
10. Hubi displays supporting sources.
11. Hubi recommends relevant materials.
12. Hubi suggests the next logical step.

---

# Homepage

The homepage should remain intentionally minimal.

Display:

- Hubi logo
- Product subtitle
- Greeting
- Conversation input
- Suggested actions

Suggested actions should encourage users to describe objectives rather than search for documentation.

Examples:

- Ask a Revenue question
- Prepare for a customer conversation
- Understand a pricing scenario
- Navigate a commercial process

Selecting a suggested action should simply prefill the conversation input.

---

# Chat Experience

The conversation should feel similar to premium AI products such as Claude.

Required capabilities:

- conversation history
- markdown rendering
- streaming responses
- loading state
- follow-up questions
- compact source references
- related materials
- suggested next step

Conversation should always remain the primary interaction.

---

# Supported Interaction Types

This sprint supports four interaction types.

## Direct Questions

Example:

"What is GDP?"

Expected behavior:

Provide a concise grounded answer with sources.

---

## Business Scenarios

Example:

"I have a prospect with offices in Germany and France."

Expected behavior:

Identify missing information.

Ask contextual follow-up questions.

Provide grounded commercial guidance.

---

## Decision Support

Example:

"Can I offer a 60% discount?"

Expected behavior:

Retrieve documented guidance.

Identify missing context.

Present documented options.

Never make the decision for the user.

---

## Process Guidance

Example:

"How do I create this opportunity?"

Expected behavior:

Guide the user through the documented process using approved documentation.

---

# Response Structure

Responses should adapt naturally to the request.

Possible sections include:

- Answer
- Key Considerations
- Process
- Available Options
- Required Approvals
- Sources
- Related Materials
- Suggested Next Step

Not every response requires every section.

Simple questions should receive simple answers.

Complex scenarios should receive richer guidance.

---

# Hubi Runtime

The prototype should introduce the first version of the Hubi Runtime.

The Runtime is responsible for coordinating every interaction.

It includes:

- Conversation Manager
- Session State
- Request Classification
- Context Builder
- Knowledge Retrieval
- Prompt Builder
- Reasoning Engine Adapter
- Citation Builder
- Response Renderer

The Runtime represents Hubi itself.

Individual components should remain modular and independently replaceable.

---

# Knowledge Retrieval

Hubi is responsible for retrieving organizational knowledge.

The Runtime should:

- identify relevant documents;
- retrieve supporting evidence;
- preserve source references;
- collect metadata;
- prioritize approved documents;
- prepare grounded context for reasoning.

The Runtime should never delegate document discovery to the language model.

---

# Prompt Builder

Every interaction should generate a structured prompt dynamically.

The prompt should contain:

- system instructions;
- conversation history;
- user request;
- retrieved knowledge;
- document metadata;
- source references;
- response instructions.

Prompt construction is a Hubi capability.

The Reasoning Engine should receive only prepared context.

---

# Reasoning Engine

The prototype will temporarily use Claude Code as its Reasoning Engine.

Claude is responsible only for:

- reasoning over retrieved context;
- generating natural language responses;
- asking follow-up questions when instructed;
- organizing the final response.

Claude should never:

- search organizational documents;
- invent organizational knowledge;
- determine source precedence;
- retrieve documentation independently.

The Reasoning Engine is intentionally replaceable.

Future production deployments should be able to substitute Claude with Gemini or another approved provider without changing the overall architecture.

---

# Knowledge Source

The prototype should use only the approved local representation of the Revenue Knowledge Base.

The knowledge base originates from the Revenue Knowledge Center stored in Google Drive.

The prototype may use locally synchronized copies of approved documents.

No external web search is permitted.

No public internet sources may be used.

No unsupported organizational knowledge may be generated by the language model.

All Revenue knowledge must originate from the approved knowledge base.

---

# Technical Scope

Implement:

- Web Application
- Hubi Runtime
- Conversation orchestration
- Local document ingestion
- Local retrieval
- Local session state
- Source references
- Modular architecture
- Claude integration as temporary Reasoning Engine

---

# Out of Scope

Do not implement:

- Google Chat deployment
- Authentication
- User accounts
- Analytics
- Admin Portal
- Explore
- Learning Paths
- Workflow execution
- Salesforce integration
- WorkRamp integration
- Google Drive API integration
- Production infrastructure
- Content governance

---

# Design Requirements

The prototype should feel:

- modern
- conversational
- trustworthy
- lightweight
- premium

Avoid:

- dashboard-heavy layouts;
- enterprise forms;
- unnecessary navigation;
- excessive configuration;
- visual clutter.

Conversation should remain the center of the experience.

---

# Prototype Strategy

The goal is not to build a simplified chatbot.

The goal is to build the real Hubi architecture while temporarily replacing unavailable production infrastructure with local components.

Temporary components include:

- Claude Code as the Reasoning Engine;
- locally synchronized knowledge;
- local retrieval;
- local execution.

These components should remain isolated behind clear interfaces so they can later be replaced by production services with minimal architectural changes.

---

# Engineering Priorities

When trade-offs are required, prioritize:

1. User experience
2. Product quality
3. Clean architecture
4. Modularity
5. Development speed

Optimize for demonstration quality rather than feature quantity.

---

# Definition of Done

This sprint is complete when a stakeholder can:

- open Hubi;
- ask a Revenue question;
- describe a commercial scenario;
- experience contextual follow-up questions;
- receive a grounded response;
- understand where the information came from;
- open the original supporting material;
- understand how Hubi helps accomplish Revenue work.

If a stakeholder finishes the demonstration believing that Hubi should become the primary interface for Revenue knowledge, the sprint has achieved its objective.