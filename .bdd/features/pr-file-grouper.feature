Feature: PR File Grouper panel on GitHub pull requests
  As a reviewer of large pull requests
  I want to filter, group, star and focus changed files
  So that I can review subsets of a big PR quickly

  # Verified in a real Chromium instance with the real extension loaded
  # (--load-extension) against real GitHub. The classic experience is what
  # anonymous users get; the new "changes" experience (login-gated) is verified
  # against a captured-structure fixture served under a github.com URL so the
  # real content script activates.

  Background:
    Given a real browser with the extension loaded
    And a GitHub pull request "Files changed" page with several changed files

  Scenario: The panel injects and opens (E11)
    When I press "Alt+Shift+G"
    Then the file-grouper panel becomes visible
    And it is rendered inside a shadow root

  Scenario: All changed files are detected and cleaned (E1, C4)
    When the panel is open
    Then the panel lists exactly the number of changed files GitHub shows
    And no listed file name contains a bidi/format control character

  Scenario: Substring filter narrows the list (E2)
    When the panel is open
    And I type ".test" into the filter
    Then only files whose path contains ".test" are shown

  Scenario: Regex filter narrows the list (E3)
    When the panel is open
    And I type "/__tests__/" into the filter
    Then only files under a "__tests__" directory are shown

  Scenario: Tests preset selects test files (E4)
    When the panel is open
    And I click the "Tests" preset chip
    Then every test/spec/__tests__ file is selected

  Scenario: Extension chip selects all files of a type (E5)
    When the panel is open
    And I click the ".js" extension chip
    Then all ".js" files are added to the selection

  Scenario: Show only isolates the selection (E6, E7)
    When the panel is open
    And I select two files
    And I click "Show only"
    Then the two selected diffs remain visible
    And every other file diff is hidden
    When I click "Show only" again
    Then all file diffs are visible again

  Scenario: Starring a file persists across reload (E8, E9, C5)
    When the panel is open
    And I star the first file
    Then that file's diff shows an accent marker
    When I reload the page and open the panel
    Then the same file is still starred

  Scenario: Saving and applying a group (E10)
    When the panel is open
    And I select some files and save them as group "batch-1"
    Then "batch-1" is listed in Groups
    When I clear the selection and click the "batch-1" group
    Then exactly those files are selected again

  Scenario: New-experience focus hides non-selected entries via :has() (E12, C1, C3)
    Given the new "changes" experience DOM is loaded
    When the panel is open
    And I select one file and click "Show only"
    Then only that file's diff region is visible in a real rendering engine

  Scenario: The panel does not auto-open (E13, C8)
    When a pull request page finishes loading
    Then the panel is closed and only the launch button is shown

  Scenario: Closing stays closed despite page mutations (E14, C8)
    When the panel is open
    And I click the close (✕) button
    And the page mutates its DOM
    Then the panel remains closed

  Scenario: Opening pushes the page left instead of hiding it (E15, C9)
    When I open the panel
    Then the document has a right margin equal to the panel width
    When I close the panel
    Then the document right margin is removed

  Scenario: Keyboard events do not leak between panel and page (E16, C10)
    Given a document-level keydown listener is watching
    When the panel is open
    And I type into the filter
    Then the document-level listener receives none of those keystrokes

  Scenario: Files are grouped under a foldable folder tree (E18, C12)
    Given files spread across several folders
    When the panel is open in tree view
    Then files are shown grouped under collapsible folder rows

  Scenario: Folding and unfolding a folder (E19, C12)
    When the panel is open in tree view
    And I click a folder row
    Then the files inside that folder are hidden
    When I click the folder row again
    Then the files inside that folder are shown

  Scenario: A folder checkbox selects everything inside it (E20, C12)
    When the panel is open in tree view
    And I tick a folder's checkbox
    Then every file under that folder becomes selected
    When I untick the folder's checkbox
    Then those files are deselected

  Scenario: Switching between tree and flat views (E21, C12)
    When the panel is open in tree view
    And I click the view toggle
    Then the list shows a flat list of full file paths with no folder rows
    When I click the view toggle again
    Then the list shows the folder tree

  Scenario: The sidebar width is drag-resizable and persists (E22, C13)
    When I drag the panel's left edge to a new width
    Then the panel resizes and the page reflow tracks the new width
    When I reload the page
    Then the panel keeps the width I set

  Scenario: A stale/compressed tree leaf never duplicates a file (E23, C16)
    Given a file-tree leaf whose path differs but shares a real file's diff id
    When the panel scans the files
    Then the file appears once with its real path and no phantom entry is shown

  Scenario: Nested files are indented under their folder (E24, C14)
    When the panel is open in tree view
    Then a file's checkbox is indented to the right of its parent folder's checkbox

  Scenario: A folder is viewed when all its files are viewed (E25, C15)
    Given a folder whose files are all marked viewed on GitHub
    When the panel renders the tree
    Then that folder row shows the viewed state
    When one of its files is no longer viewed
    Then the folder no longer shows the viewed state

  Scenario: Mark a file viewed from the panel row (E26, C17)
    When the panel is open
    And I click a file row's viewed toggle
    Then that file is marked viewed on GitHub and the row shows it as viewed

  Scenario: Everything is under a top-level "pr" folder (E27, C18)
    When the panel is open in tree view
    Then a single "pr" folder contains every changed file
    And ticking the "pr" folder checkbox selects all files
    And the "pr" folder shows viewed once every file is viewed

  Scenario: Toolbar controls are grouped by purpose (C19)
    When the panel is open
    Then the type chips are labelled "Select by type"
    And the view controls are grouped under "View"
    And the selection actions are grouped under "Selection"
