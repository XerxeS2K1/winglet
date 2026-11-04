package expo.modules.wingletpush
import org.junit.Assert.*
import org.junit.Test
class NoteTagTest {
  private val scope="a".repeat(64)
  @Test fun theTagIsTheScopeAndTheHashOfTheServersTag(){
    // sha256("inbox-1") written out, so a change to how notes are tagged breaks clearing and fails here.
    assertEquals(scope+":aa46dffbd83f240f92968706f4c54301c6e5e8c41878a88719a2bdceba0a5210",PushStore.noteTag(scope,"inbox-1"))
  }
  @Test fun differentCardsGetDifferentTags(){ assertNotEquals(PushStore.noteTag(scope,"inbox-1"),PushStore.noteTag(scope,"inbox-2")) }
  @Test fun theSameCardInAnotherPairingGetsAnotherTag(){ assertNotEquals(PushStore.noteTag(scope,"chat-x"),PushStore.noteTag("b".repeat(64),"chat-x")) }
  @Test fun theTagKeepsTheShapeTheLogoutSweepMatches(){
    assertTrue(Regex("^[a-f0-9]{64}:[a-f0-9]{64}$").matches(PushStore.noteTag(scope,"chat-general")))
  }
}
