import type { GitLabWorkItem } from '../../../shared/gitlab-types'

// Client-side keyword filter for the shared GitLab/Gitea issue & MR list. We
// match only what the row actually displays — the title and the `#<number>`
// reference — so every result visibly contains the query. Matching hidden
// fields (labels, author) would surface rows that look unrelated to what the
// user typed.
export function filterGitLabItemsBySearch(
  items: readonly GitLabWorkItem[],
  rawQuery: string
): GitLabWorkItem[] {
  const query = rawQuery.trim().toLowerCase()
  if (!query) {
    return [...items]
  }
  return items.filter((item) => `${item.title} #${item.number}`.toLowerCase().includes(query))
}
