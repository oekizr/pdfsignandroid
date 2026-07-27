package com.oekizr.wakyengpdfsign

import android.content.Intent
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.TextView
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.webkit.WebViewAssetLoader
import com.google.android.gms.auth.GoogleAuthUtil
import com.google.android.gms.auth.UserRecoverableAuthException
import com.google.android.gms.auth.api.signin.GoogleSignIn
import com.google.android.gms.auth.api.signin.GoogleSignInAccount
import com.google.android.gms.auth.api.signin.GoogleSignInClient
import com.google.android.gms.auth.api.signin.GoogleSignInOptions
import com.google.android.gms.common.api.ApiException
import com.google.android.gms.common.api.Scope
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.util.regex.Pattern

private const val TAG = "WakyengPdfSign"
private const val DRIVE_SCOPE = "oauth2:https://www.googleapis.com/auth/drive"

class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var emptyState: View
    private lateinit var emptyStateText: TextView
    private lateinit var linkInput: EditText
    private lateinit var openLinkBtn: Button
    private lateinit var googleSignInClient: GoogleSignInClient
    private lateinit var assetLoader: WebViewAssetLoader

    private var pendingFileId: String? = null
    private var currentToken: String? = null

    private val signInLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        val task = GoogleSignIn.getSignedInAccountFromIntent(result.data)
        try {
            val account = task.getResult(ApiException::class.java)
            fetchTokenAndLoad(account)
        } catch (e: ApiException) {
            Log.e(TAG, "Sign-in failed", e)
            showEmptyState("Login Google gagal: ${e.message}")
        }
    }

    private val recoverConsentLauncher = registerForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
        if (result.resultCode == RESULT_OK) {
            val account = GoogleSignIn.getLastSignedInAccount(this)
            if (account != null) fetchTokenAndLoad(account)
        } else {
            showEmptyState("Izin akses Google Drive dibatalkan.")
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.webview)
        emptyState = findViewById(R.id.empty_state)
        emptyStateText = findViewById(R.id.empty_state_text)
        linkInput = findViewById(R.id.link_input)
        openLinkBtn = findViewById(R.id.open_link_btn)

        val gso = GoogleSignInOptions.Builder(GoogleSignInOptions.DEFAULT_SIGN_IN)
            .requestEmail()
            .requestScopes(Scope("https://www.googleapis.com/auth/drive"))
            .build()
        googleSignInClient = GoogleSignIn.getClient(this, gso)

        setupWebView()

        openLinkBtn.setOnClickListener {
            val text = linkInput.text.toString().trim()
            if (text.isNotEmpty()) tryOpenLink(text)
        }

        showEmptyState("Buka PDF di Google Drive, tap menu (⋮) lalu Copy link, kemudian tempel di sini:")
        handleIncomingIntent(intent)
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIncomingIntent(intent)
    }

    private fun setupWebView() {
        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.settings.javaScriptEnabled = true
        webView.settings.domStorageEnabled = true
        webView.settings.useWideViewPort = true
        webView.settings.loadWithOverviewMode = true
        webView.settings.setSupportZoom(false)
        webView.settings.builtInZoomControls = false
        webView.settings.displayZoomControls = false
        webView.addJavascriptInterface(TokenBridge(), "AndroidTokenBridge")

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest) =
                assetLoader.shouldInterceptRequest(request.url)

            override fun onPageFinished(view: WebView, url: String?) {
                currentToken?.let { token ->
                    view.evaluateJavascript("window.setAndroidToken(" + JSONObject.quote(token) + ");", null)
                }
            }
        }
    }

    private inner class TokenBridge {
        @JavascriptInterface
        fun getToken(): String = currentToken ?: ""
    }

    private fun handleIncomingIntent(intent: Intent) {
        if (intent.action != Intent.ACTION_SEND) return
        val sharedText = intent.getStringExtra(Intent.EXTRA_TEXT) ?: return
        tryOpenLink(sharedText)
    }

    private fun tryOpenLink(text: String) {
        val fileId = extractDriveFileId(text)
        if (fileId == null) {
            showEmptyState("Link Google Drive PDF tidak dikenali. Pastikan link berbentuk drive.google.com/file/d/...")
            return
        }
        pendingFileId = fileId
        startSignIn()
    }

    private fun extractDriveFileId(text: String): String? {
        val patterns = listOf(
            Pattern.compile("/file/d/([a-zA-Z0-9_-]+)"),
            Pattern.compile("[?&]id=([a-zA-Z0-9_-]+)")
        )
        for (pattern in patterns) {
            val matcher = pattern.matcher(text)
            if (matcher.find()) return matcher.group(1)
        }
        return null
    }

    private fun startSignIn() {
        val existing = GoogleSignIn.getLastSignedInAccount(this)
        if (existing != null) {
            fetchTokenAndLoad(existing)
        } else {
            signInLauncher.launch(googleSignInClient.signInIntent)
        }
    }

    private fun fetchTokenAndLoad(account: GoogleSignInAccount) {
        val fileId = pendingFileId ?: return
        val googleAccount = account.account
        if (googleAccount == null) {
            showEmptyState("Tidak bisa mengakses akun Google, coba login ulang.")
            return
        }

        CoroutineScope(Dispatchers.IO).launch {
            try {
                val token = GoogleAuthUtil.getToken(this@MainActivity, googleAccount, DRIVE_SCOPE)
                withContext(Dispatchers.Main) { loadEditor(fileId, token) }
            } catch (e: UserRecoverableAuthException) {
                withContext(Dispatchers.Main) { recoverConsentLauncher.launch(e.intent) }
            } catch (e: Exception) {
                Log.e(TAG, "Gagal mengambil token", e)
                withContext(Dispatchers.Main) {
                    showEmptyState("Gagal mendapatkan izin akses Drive: ${e.message}")
                }
            }
        }
    }

    private fun loadEditor(fileId: String, token: String) {
        currentToken = token
        emptyState.visibility = View.GONE
        webView.visibility = View.VISIBLE
        webView.loadUrl("https://appassets.androidplatform.net/assets/editor.html?fileId=$fileId")
    }

    private fun showEmptyState(message: String) {
        emptyStateText.text = message
        emptyState.visibility = View.VISIBLE
        webView.visibility = View.GONE
    }
}
