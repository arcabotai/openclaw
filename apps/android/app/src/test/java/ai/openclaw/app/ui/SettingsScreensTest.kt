package ai.openclaw.app.ui

import ai.openclaw.app.GatewayConnectionProblem
import ai.openclaw.app.GatewayExecApprovalNotice
import ai.openclaw.app.GatewayExecApprovalSummary
import ai.openclaw.app.GatewayNodeCapabilityApproval
import ai.openclaw.app.LocationMode
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Files
import java.nio.file.Path

class SettingsScreensTest {
  @Test
  fun locationModes_hideAlwaysFromPlayAndMapThirdPartySelection() {
    assertEquals(listOf("Off", "While Using"), locationModeLabels(backgroundLocationAvailable = false))
    assertEquals(
      listOf("Off", "While Using", "Always"),
      locationModeLabels(backgroundLocationAvailable = true),
    )
    assertEquals(LocationMode.Always, locationModeForLabel("Always"))
  }

  @Test
  fun androidDistributionChannelUsesBuildFlavorLabels() {
    assertEquals("Play", androidDistributionChannel("play"))
    assertEquals("Third-party", androidDistributionChannel("thirdParty"))
    assertEquals("Unknown", androidDistributionChannel(""))
  }

  @Test
  fun gatewayStatusLabelReportsWhichAuthRecoveryAppliesInsteadOfGenericLabel() {
    assertEquals(
      "Setup code expired",
      gatewayStatusLabel(
        "Gateway error: unauthorized: bootstrap token invalid or expired",
        isConnected = false,
        gatewayConnectionProblem = authProblem("AUTH_BOOTSTRAP_TOKEN_INVALID"),
      ),
    )
    assertEquals(
      "Device identity required",
      gatewayStatusLabel(
        "Gateway error: device identity required",
        isConnected = false,
        gatewayConnectionProblem = authProblem("DEVICE_IDENTITY_REQUIRED"),
      ),
    )
  }

  @Test
  fun gatewayStatusLabelFallsBackToGenericAuthLabelWithoutAKnownReason() {
    assertEquals("Authentication needed", gatewayStatusLabel("auth failed", isConnected = false, gatewayConnectionProblem = null))
    assertEquals(
      "Authentication needed",
      gatewayStatusLabel("auth failed", isConnected = false, gatewayConnectionProblem = authProblem("SOME_UNMAPPED_CODE")),
    )
  }

  @Test
  fun gatewayStatusLabelLeavesUnrelatedStatesUnaffectedByConnectionProblem() {
    val problem = authProblem("AUTH_TOKEN_MISSING")
    assertEquals("Ready", gatewayStatusLabel("auth failed", isConnected = true, gatewayConnectionProblem = authProblem("AUTH_TOKEN_MISSING")))
    assertEquals("Pairing needed", gatewayStatusLabel("Pairing in progress", isConnected = false, gatewayConnectionProblem = problem))
    assertEquals("Cannot reach gateway", gatewayStatusLabel("Connection failed", isConnected = false, gatewayConnectionProblem = problem))
  }

  @Test
  fun gatewaySetupResetCopyExplainsCredentialAndApprovalImpact() {
    val text = gatewaySettingsSetupResetConfirmationText()

    assertEquals(true, text.contains("saved setup credentials"))
    assertEquals(true, text.contains("device tokens"))
    assertEquals(true, text.contains("node capability approval"))
  }

  @Test
  fun devicePairingAdminCopySeparatesPairingFromNodeApproval() {
    val text = devicePairingAdminUnavailableText()

    assertEquals(true, text.contains("approve new phone pairing"))
    assertEquals(true, text.contains("Node capability approval is separate"))
    assertEquals(true, text.contains("nodes approve <request id>"))
  }

  @Test
  fun nodeApprovalCommandUsesOnlyASafeExactRequestId() {
    assertEquals(
      "openclaw nodes approve request-1",
      gatewayNodeApprovalCommand(GatewayNodeCapabilityApproval.PendingApproval("request-1")),
    )
    assertEquals(
      "openclaw nodes status",
      gatewayNodeApprovalCommand(GatewayNodeCapabilityApproval.PendingReapproval("request-1; unsafe")),
    )
    assertEquals(null, gatewayNodeApprovalCommand(GatewayNodeCapabilityApproval.Approved))
  }

  @Test
  fun cronDetailRefreshRecoversWhenDirtyDraftHasNoLoadedJob() {
    assertEquals(
      true,
      cronDetailRefreshEnabled(
        isConnected = true,
        loading = false,
        hasCurrentJob = false,
        draftRequiresResolution = true,
        saveSucceeded = false,
      ),
    )
    assertEquals(
      false,
      cronDetailRefreshEnabled(
        isConnected = true,
        loading = false,
        hasCurrentJob = true,
        draftRequiresResolution = true,
        saveSucceeded = false,
      ),
    )
  }

  @Test
  fun cronDetailDisposalRetainsTransientStateOnlyForActivityRecreation() {
    assertEquals(false, cronDetailDisposalClearsTransientState(isChangingConfigurations = true))
    assertEquals(true, cronDetailDisposalClearsTransientState(isChangingConfigurations = false))
  }

  @Test
  fun approvalActionsUseUnabridgedSafetyLabelsInLargeFontSafeOrder() {
    assertEquals(
      listOf(
        ExecApprovalAction("allow-once", "Allow Once"),
        ExecApprovalAction("allow-always", "Allow Always"),
        ExecApprovalAction("deny", "Deny"),
      ),
      execApprovalActions(listOf("allow-once", "allow-always", "deny")),
    )
  }

  @Test
  fun approvalCardShowsTheWholeMonospacedCommandBeforeStackedActions() {
    val source = settingsScreensSource()
    val cardStart = source.indexOf("private fun ExecApprovalCard(")
    val reviewCall = source.indexOf("ExecApprovalCommandReview(approval.commandText)", cardStart)
    val actionsCall = source.indexOf("execApprovalActions(approval.allowedDecisions)", reviewCall)
    val reviewStart = source.indexOf("private fun ExecApprovalCommandReview(", actionsCall)
    val reviewEnd = source.indexOf("internal data class ExecApprovalAction", reviewStart)
    val reviewBody = source.substring(reviewStart, reviewEnd)
    val actionBody = source.substring(reviewCall, reviewStart)

    assertTrue(cardStart >= 0 && reviewCall > cardStart && actionsCall > reviewCall)
    assertTrue(reviewBody.contains("FontFamily.Monospace"))
    assertFalse(reviewBody.contains("maxLines"))
    assertFalse(reviewBody.contains("TextOverflow"))
    assertTrue(actionBody.contains("Column(modifier = Modifier.fillMaxWidth()"))
    assertFalse(actionBody.contains("Modifier.weight(1f)"))
  }

  @Test
  fun approvalNoticeMatchesOnlyTheExactOpaqueApprovalId() {
    val exactId = "\uFEFF approval-edge \u00A0"
    val notice =
      GatewayExecApprovalNotice(
        approvalId = exactId,
        message = "Approval denied.",
        warning = true,
      )

    assertSame(notice, execApprovalNoticeForCard(notice, exactId))
    assertNull(execApprovalNoticeForCard(notice, "approval-edge"))
    assertNull(execApprovalNoticeForCard(notice, "\uFEFFapproval-edge\u00A0"))
  }

  @Test
  fun terminalNoticeIsOrphanedOnlyWhenNoOtherApprovalCardIsVisible() {
    val notice =
      GatewayExecApprovalNotice(
        approvalId = "approval-1",
        message = "Approval denied.",
        warning = true,
      )

    assertSame(notice, execApprovalEmptyInboxNotice(notice, emptyList()))
    assertNull(
      execApprovalEmptyInboxNotice(
        notice,
        listOf(approvalSummary(id = "approval-2")),
      ),
    )
  }

  private fun approvalSummary(id: String): GatewayExecApprovalSummary =
    GatewayExecApprovalSummary(
      id = id,
      commandText = "echo test",
      commandPreview = null,
      warningText = null,
      allowedDecisions = listOf("deny"),
      host = null,
      nodeId = null,
      agentId = null,
      createdAtMs = 1,
      expiresAtMs = 2,
    )

  private fun settingsScreensSource(): String {
    val candidates =
      listOf(
        Path.of("src/main/java/ai/openclaw/app/ui/SettingsScreens.kt"),
        Path.of("apps/android/app/src/main/java/ai/openclaw/app/ui/SettingsScreens.kt"),
      )
    val path = candidates.firstOrNull(Files::exists) ?: error("SettingsScreens.kt not found")
    return Files.readString(path)
  }

  private fun authProblem(code: String): GatewayConnectionProblem =
    GatewayConnectionProblem(
      code = code,
      message = "Authentication failed.",
      reason = null,
      requestId = null,
      recommendedNextStep = null,
      pauseReconnect = false,
      retryable = false,
    )
}
